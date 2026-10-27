/* EduTrace AI — Student Integrity Graph
   SIH 26263 · Deterministic SVG layout of persisted relationships.
   Institutions are columns; each linked group of source records occupies its
   own band so related records sit side by side. Every edge is backed by a
   persisted finding or a source-of-record assignment returned by /api/v1/graph.
   ──────────────────────────────────────────────── */
'use strict';

const G_REL = {
  exact: { label: 'Exact identifier match', note: 'Exact means a local comparison of protected identifier fingerprints. It is not APAAR verification.' },
  candidate: { label: 'Candidate match', note: 'Uncertain relationship. Similar name and the same date of birth, with no identifier — inconclusive by design. The records were not merged.' },
  conflict: { label: 'Identity conflict', note: 'The records share an identifier but disagree on name and/or date of birth. Which record is correct is not established.' },
  source: { label: 'Source-of-record link', note: 'Records which institution submitted this source row. It is a persisted assignment, not an inferred match.' },
  confirmed: { label: 'Same person (user decision)', note: 'A user recorded these records as the same student. The source records stay separate and unchanged.' },
  rejected: { label: 'Different people (user decision)', note: 'A user recorded these records as different students. Shown for the audit trail; it does not group them.' },
  withdrawn: { label: 'Automatic link withdrawn', note: 'These records were linked automatically, then new evidence contradicted the link. Shown for the audit trail; it does not group them.' },
  simulated: { label: 'Simulated relationship (hypothetical)', note: 'SIMULATION ONLY. This relationship exists only in an isolated copy where a staged correction was applied. It is not a recorded link, finding or decision, and nothing was saved.' }
};
const G_SIM_CHANGE = { added: 'would be added', removed: 'would no longer apply', affected: 'evidence would change' };
const G_SEVERITY_ORDER = ['conflict', 'exact', 'candidate'];
const G_MAX_RECORDS = 160;
const G_GEOM = { pad: 28, colW: 270, headY: 16, headH: 48, top: 104, rowH: 64, bandGap: 22 };

const gx = {
  data: null,
  layout: null,
  query: '',
  mode: null,
  zoom: 1,
  selected: null,
  token: 0,
  truncated: null,
  /* Simulation overlay from the Evidence Impact Lab. gx.data stays exactly what the server returned. */
  sim: null,
  view: null
};

/* ── Route Integration ────────────────────────── */
registerView('graph', {
  enter() {
    if (!gx.mode) gx.mode = mobileQuery.matches ? 'table' : 'graph';
    gApplyMode();
    gLoad();
  }
});

async function gLoad() {
  const token = ++gx.token;
  const params = new URLSearchParams();
  if ($('#gInstitution').value) params.set('institution', $('#gInstitution').value);
  if ($('#gRelationship').value) params.set('relationship', $('#gRelationship').value);
  if ($('#gStatus').value) params.set('status', $('#gStatus').value);
  $$('.graph-toolbar select').forEach(select => select.classList.toggle('is-set', Boolean(select.value)));

  $('#gStats').textContent = 'Loading relationship evidence…';
  $('#gCanvas').innerHTML = `<div class="empty-state"><span class="skel" style="width:60%;height:14px"></span><span class="skel" style="width:40%;height:14px"></span></div>`;

  try {
    const response = await api('/api/v1/graph' + (params.toString() ? `?${params}` : ''));
    if (token !== gx.token) return;
    gx.data = response.data;
    gx.view = gMerge();
    gx.selected = gx.sim ? { kind: 'node', id: gx.sim.focus } : null;

    const select = $('#gInstitution');
    const current = select.value;
    select.innerHTML = '<option value="">All accessible</option>' + response.data.filters.institutions.map(code => `<option value="${esc(code)}">${esc(code)}</option>`).join('');
    select.value = response.data.filters.institutions.includes(current) ? current : '';
    select.classList.toggle('is-set', Boolean(select.value));

    gx.layout = gLayout(gx.view);
    gRenderAll({ animate: true });
    gRenderSimBar();
  } catch (error) {
    if (token !== gx.token) return;
    gx.data = null;
    gx.view = null;
    gx.layout = null;
    $('#gStats').textContent = 'Graph unavailable';
    $('#gCanvas').innerHTML = errorState(error.message, 'data-retry-graph');
    $('#gTableWrap').innerHTML = '';
    $('#gLegend').innerHTML = '';
    $('#gPanel').innerHTML = '';
    $('[data-retry-graph]')?.addEventListener('click', gLoad);
  }
}

/* ── Layout ───────────────────────────────────── */
/* Edge types drawn as solid lines; only these are animated by drawing (dashed patterns fade in). */
const G_SOLID = new Set(['exact', 'confirmed', 'source']);

function gWorstType(node) {
  const types = (node.detail?.findings || []).map(f => f.type);
  return G_SEVERITY_ORDER.find(type => types.includes(type)) || 'exact';
}

function gNodeStatus(node) {
  const statuses = (node.detail?.findings || []).map(f => f.review_status);
  if (statuses.length && statuses.every(s => s === 'resolved')) return 'resolved';
  if (statuses.includes('pending')) return 'pending';
  return statuses.length ? 'awaiting_verification' : 'pending';
}

function gLayout(data) {
  const institutions = data.nodes.filter(n => n.type === 'institution').sort((a, b) => a.institution_code.localeCompare(b.institution_code));
  const allRecords = data.nodes.filter(n => n.type === 'record');
  /* Rejected and withdrawn relationships are drawn for the audit trail but never group records. */
  /* Simulated edges never group records either: the authoritative layout stays where it is. */
  const matchEdges = data.edges.filter(e => !['source', 'rejected', 'withdrawn', 'simulated'].includes(e.type));

  /* Connected groups via union-find over match edges */
  const parent = new Map(allRecords.map(r => [r.id, r.id]));
  const find = id => { while (parent.get(id) !== id) { parent.set(id, parent.get(parent.get(id))); id = parent.get(id); } return id; };
  matchEdges.forEach(edge => { if (parent.has(edge.source) && parent.has(edge.target)) parent.set(find(edge.source), find(edge.target)); });
  const groups = new Map();
  allRecords.forEach(record => {
    const root = find(record.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(record);
  });
  const components = [...groups.values()].sort((a, b) =>
    new Set(b.map(r => r.institution_code)).size - new Set(a.map(r => r.institution_code)).size ||
    b.length - a.length ||
    a[0].institution_code.localeCompare(b[0].institution_code) ||
    a[0].detail.source_row - b[0].detail.source_row);

  /* Bound the rendered set to keep the graph readable */
  const kept = [];
  let count = 0;
  for (const component of components) {
    if (count + component.length > G_MAX_RECORDS && kept.length) break;
    kept.push(component);
    count += component.length;
  }
  gx.truncated = count < allRecords.length ? { shown: count, total: allRecords.length } : null;

  const { pad, top, rowH, bandGap } = G_GEOM;
  const available = $('#gCanvas').clientWidth || 0;
  const colW = available ? Math.max(230, Math.min(320, Math.floor((available - pad * 2 + 24) / Math.max(institutions.length, 1)))) : G_GEOM.colW;
  const colIndex = new Map(institutions.map((n, i) => [n.institution_code, i]));
  const width = Math.max(pad * 2 + institutions.length * colW - 24, 600);
  const positions = new Map();
  const bands = [];
  let y = top;

  kept.forEach((members, index) => {
    const byCol = new Map();
    members.forEach(record => {
      const col = colIndex.get(record.institution_code) ?? 0;
      if (!byCol.has(col)) byCol.set(col, []);
      byCol.get(col).push(record);
    });
    let rows = 1;
    byCol.forEach((list, col) => {
      list.sort((a, b) => a.detail.source_row - b.detail.source_row);
      rows = Math.max(rows, list.length);
      list.forEach((record, k) => {
        const colLeft = pad + col * colW;
        positions.set(record.id, { x: colLeft + 58, y: y + 22 + k * rowH, colLeft });
      });
    });
    bands.push({ y0: y, y1: y + rows * rowH - 4, index: index + 1, size: members.length });
    y += rows * rowH + bandGap;
  });

  institutions.forEach((node, i) => {
    positions.set(node.id, { x: pad + i * colW, y: G_GEOM.headY, colLeft: pad + i * colW });
  });

  const keptIds = new Set(kept.flat().map(r => r.id));
  return {
    width,
    colW,
    height: Math.max(y + 8, 320),
    institutions,
    records: allRecords.filter(r => keptIds.has(r.id)),
    edges: data.edges.filter(e => (e.type === 'source' ? keptIds.has(e.target) : keptIds.has(e.source) && keptIds.has(e.target))),
    positions,
    bands
  };
}

/* ── Search & Focus Sets ──────────────────────── */
const gNormal = value => String(value ?? '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-IN');

function gSearchMatches() {
  if (!gx.query || !gx.layout) return null;
  const matches = new Set();
  [...gx.layout.institutions, ...gx.layout.records].forEach(node => {
    const d = node.detail || {};
    const text = gNormal([
      node.label, node.institution_code, node.institution_name, d.student_name, d.programme, d.academic_session,
      d.source_row, d.source_batch, d.source_file, d.apaar_id,
      ...(d.findings || []).flatMap(f => [f.id, f.title, f.rule_code])
    ].join(' '));
    if (text.includes(gx.query)) matches.add(node.id);
  });
  return matches;
}

function gFocusSets() {
  const layout = gx.layout;
  if (gx.selected) {
    const nodes = new Set();
    const edges = new Set();
    if (gx.selected.kind === 'edge') {
      const edge = layout.edges.find(e => e.id === gx.selected.id);
      if (edge) { edges.add(edge.id); nodes.add(edge.source); nodes.add(edge.target); }
    } else {
      nodes.add(gx.selected.id);
      layout.edges.forEach(edge => {
        if (edge.source === gx.selected.id || edge.target === gx.selected.id) {
          edges.add(edge.id); nodes.add(edge.source); nodes.add(edge.target);
        }
      });
    }
    return { nodes, edges };
  }
  const matches = gSearchMatches();
  if (!matches) return null;
  const nodes = new Set(matches);
  const edges = new Set();
  layout.edges.forEach(edge => {
    if (edge.type !== 'source' && (matches.has(edge.source) || matches.has(edge.target))) {
      edges.add(edge.id); nodes.add(edge.source); nodes.add(edge.target);
    }
    if (edge.type === 'source' && matches.has(edge.target)) { edges.add(edge.id); nodes.add(edge.source); }
  });
  return { nodes, edges, matches };
}

/* ── Rendering ────────────────────────────────── */
function gRenderAll({ animate = false } = {}) {
  gRenderStats();
  gRenderLegend();
  if (gx.mode === 'table') gRenderTable(); else gRenderSvg({ animate });
  gRenderPanel();
}

function gRenderStats() {
  const layout = gx.layout;
  const rels = layout.edges.filter(e => e.type !== 'source').length;
  const matches = gSearchMatches();
  let text = `<strong>${layout.institutions.length}</strong> ${layout.institutions.length === 1 ? 'institution' : 'institutions'} · <strong>${layout.records.length}</strong> linked source ${layout.records.length === 1 ? 'record' : 'records'} · <strong>${rels}</strong> ${rels === 1 ? 'relationship' : 'relationships'}`;
  if (gx.truncated) text += ` · showing ${gx.truncated.shown} of ${gx.truncated.total} records — narrow with filters`;
  if (gx.sim) text += ` · <strong class="g-sim-stat">SIMULATION</strong> ${plural(gx.sim.edges.length, 'hypothetical change')}`;
  if (matches) text += matches.size ? ` · <strong>${matches.size}</strong> ${matches.size === 1 ? 'match' : 'matches'} for “${esc(gx.query)}”` : ` · no matches for “${esc(gx.query)}”`;
  $('#gStats').innerHTML = text;
}

function gRenderLegend() {
  const counts = type => gx.layout.edges.filter(e => e.type === type).length;
  $('#gLegend').innerHTML = `
    <span class="legend-item"><span class="legend-inst"></span>Institution</span>
    <span class="legend-item"><span class="legend-line source"></span>Source-of-record link</span>
    <span class="legend-sep" aria-hidden="true"></span>
    <span class="legend-item"><span class="legend-line exact"></span>Exact identifier <strong>${counts('exact')}</strong></span>
    <span class="legend-item"><span class="legend-line candidate"></span>Candidate (uncertain) <strong>${counts('candidate')}</strong></span>
    <span class="legend-item"><span class="legend-line conflict"></span>Identity conflict <strong>${counts('conflict')}</strong></span>
    <span class="legend-item"><span class="legend-line confirmed"></span>Same person (user decision) <strong>${counts('confirmed')}</strong></span>
    <span class="legend-item"><span class="legend-line rejected"></span>Different people (user decision) <strong>${counts('rejected')}</strong></span>
    <span class="legend-item"><span class="legend-line withdrawn"></span>Automatic link withdrawn <strong>${counts('withdrawn')}</strong></span>
    <span class="legend-sep" aria-hidden="true"></span>
    <span class="legend-item"><span class="legend-node conflict"></span><span class="legend-node exact"></span><span class="legend-node candidate"></span>Record coloured by its strongest relationship</span>
    <span class="legend-item"><span class="legend-node resolved"></span>All linked findings resolved · dashed ring = awaiting verification</span>${gx.sim ? `
    <span class="legend-sep" aria-hidden="true"></span>
    <span class="legend-item legend-sim"><span class="legend-line simulated"></span>Simulated relationship (hypothetical) <strong>${gx.sim.edges.filter(e => e.change === 'added').length}</strong></span>
    <span class="legend-item legend-sim"><span class="legend-line sim-removed"></span>Actual relationship that would no longer apply <strong>${gx.sim.edges.filter(e => e.change === 'removed').length}</strong></span>
    <span class="legend-item legend-sim"><span class="legend-line sim-affected"></span>Actual relationship whose evidence would change <strong>${gx.sim.edges.filter(e => e.change === 'affected').length}</strong></span>
    <span class="legend-item legend-sim"><span class="legend-node sim-focus"></span>Record being evaluated</span>` : ''}`;
}

function gTruncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function gEdgePath(edge, pos, parallelIndex) {
  const a = pos.get(edge.source);
  const b = pos.get(edge.target);
  if (!a || !b) return null;
  if (edge.type === 'source') {
    return `M ${a.colLeft + 14} ${b.y} H ${b.x - 9}`;
  }
  if (a.colLeft === b.colLeft) {
    const [top, bottom] = a.y <= b.y ? [a, b] : [b, a];
    const bulge = 44 + parallelIndex * 14;
    return `M ${top.x - 8} ${top.y} C ${top.x - bulge} ${top.y}, ${bottom.x - bulge} ${bottom.y}, ${bottom.x - 8} ${bottom.y}`;
  }
  const [left, right] = a.x <= b.x ? [a, b] : [b, a];
  const lift = 48 + parallelIndex * 16;
  return `M ${left.x} ${left.y - 8} C ${left.x + 10} ${left.y - lift}, ${right.x - 10} ${right.y - lift}, ${right.x} ${right.y - 8}`;
}

/* Entrance motion runs only when new graph data arrives (first load or a filter change), never on
   selection, search or resize, and only for edges and nodes that the server returned. */
let gEnterTimer;
function gRenderSvg({ animate = false } = {}) {
  const layout = gx.layout;
  const canvas = $('#gCanvas');
  if (!layout.records.length) {
    const filtered = $('#gInstitution').value || $('#gRelationship').value || $('#gStatus').value;
    canvas.innerHTML = emptyState({
      iconName: 'graph',
      title: filtered ? 'No relationships match these filters' : 'No linked records in your scope',
      text: filtered ? 'Try another institution, relationship type or finding status.' : 'Relationships appear here when reconciliation links source records through a finding.',
      action: filtered ? '<button type="button" class="btn btn-secondary btn-sm" data-g-clear-filters>Clear graph filters</button>' : ''
    });
    $('[data-g-clear-filters]')?.addEventListener('click', gClearFilters);
    return;
  }

  const pos = layout.positions;
  const focus = gFocusSets();
  const { headY, headH } = G_GEOM;
  const colW = layout.colW;
  const labelChars = Math.max(14, Math.floor((colW - 96) / 7));

  const bands = layout.bands.map(band => `<rect class="g-band" x="${G_GEOM.pad - 8}" y="${band.y0}" width="${layout.width - G_GEOM.pad * 2 + 16}" height="${band.y1 - band.y0}" rx="10"/>`).join('');

  /* Rails from each institution header to its last record */
  const rails = layout.institutions.map(inst => {
    const p = pos.get(inst.id);
    const ys = layout.records.filter(r => r.institution_code === inst.institution_code).map(r => pos.get(r.id).y);
    if (!ys.length) return '';
    return `<path class="g-rail" d="M ${p.colLeft + 14} ${headY + headH} V ${Math.max(...ys)}"/>`;
  }).join('');

  const pairCount = new Map();
  const edgeSvg = layout.edges.map(edge => {
    const key = [edge.source, edge.target].sort().join('|');
    const index = edge.type === 'source' ? 0 : (pairCount.get(key) || 0);
    if (edge.type !== 'source') pairCount.set(key, index + 1);
    const d = gEdgePath(edge, pos, index);
    if (!d) return '';
    const status = edge.evidence?.review_status;
    const hot = focus && focus.edges.has(edge.id) ? ' is-hot' : '';
    const selected = gx.selected?.kind === 'edge' && gx.selected.id === edge.id ? ' is-selected' : '';
    const label = edge.type === 'source'
      ? `Source-of-record link: ${edge.evidence?.institution_code} row ${edge.evidence?.source_row}`
      : edge.type === 'simulated' ? `SIMULATION: ${G_REL[edge.sim.relationship]?.label || edge.sim.relationship} would be added (hypothetical): ${edge.evidence?.title || ''}`
      : `${G_REL[edge.type].label}${status ? `, ${statusLabel(status)}` : ''}: ${edge.evidence?.title || ''}${edge.sim ? `. SIMULATION: ${G_SIM_CHANGE[edge.sim.change]}` : ''}`;
    const simClass = edge.sim ? ` sim-${edge.sim.change}` : '';
    return `<g class="g-edge-group${hot}${selected}${simClass}" data-edge="${esc(edge.id)}" tabindex="0" role="button" aria-label="${esc(label)}">
      <title>${esc(label)}</title>
      <path class="g-hit" d="${d}"/>
      <path class="g-edge ${edge.type}${status === 'resolved' ? ' is-resolved' : ''}" d="${d}"${G_SOLID.has(edge.type) ? ' pathLength="1"' : ''}/>
      ${edge.type === 'source' || edge.type === 'simulated' ? '' : `<path class="g-edge-flow" d="${d}"/>`}${edge.sim && edge.type !== 'simulated' ? `<path class="g-edge-sim-mark" d="${d}"/>` : ''}
    </g>`;
  }).join('');

  const instSvg = layout.institutions.map(inst => {
    const p = pos.get(inst.id);
    const recordCount = layout.records.filter(r => r.institution_code === inst.institution_code).length;
    const hot = focus && focus.nodes.has(inst.id) ? ' is-hot' : '';
    const selected = gx.selected?.id === inst.id ? ' is-selected' : '';
    const label = `${inst.institution_code}, ${inst.institution_name}: ${recordCount} linked source records`;
    return `<g class="g-node g-inst${hot}${selected}" data-node="${esc(inst.id)}" style="--i:${layout.institutions.indexOf(inst)}" tabindex="0" role="button" aria-label="${esc(label)}">
      <title>${esc(label)}</title>
      <rect x="${p.colLeft}" y="${headY}" width="${colW - 28}" height="${headH}" rx="10"/>
      <rect class="g-inst-accent" x="${p.colLeft + colW - 28 - 40}" y="${headY + 13}" width="26" height="3" rx="1.5"/>
      <text x="${p.colLeft + 14}" y="${headY + 21}">${esc(inst.institution_code)}</text>
      <text class="g-inst-sub" x="${p.colLeft + 14}" y="${headY + 37}">${esc(gTruncate(inst.institution_name, 30))} · ${recordCount}</text>
    </g>`;
  }).join('');

  const recordSvg = layout.records.map(node => {
    const p = pos.get(node.id);
    const d = node.detail;
    const type = gWorstType(node);
    const status = gNodeStatus(node);
    const hot = focus && focus.nodes.has(node.id) ? ' is-hot' : '';
    const selected = gx.selected?.id === node.id ? ' is-selected' : '';
    const statusClass = status === 'resolved' ? ' is-resolved' : status === 'awaiting_verification' ? ' is-awaiting' : '';
    const simClass = gx.sim ? `${node.id === gx.sim.focus ? ' is-sim-focus' : ''}${node.sim_added ? ' is-sim-added' : ''}${node.hypothetical ? ' is-hypothetical' : ''}` : '';
    const label = `${d.student_name}, ${d.institution_code} source row ${d.source_row}, ${d.source_file}. ${plural(d.findings.length, 'linked finding')}; ${statusLabel(status)}.`;
    return `<g class="g-node ${type}${statusClass}${simClass}${hot}${selected}" data-node="${esc(node.id)}" style="--i:${Math.min(layout.records.indexOf(node), 28) + 3}" tabindex="0" role="button" aria-label="${esc(label)}">
      <title>${esc(label)}</title>
      <circle class="g-halo" cx="${p.x}" cy="${p.y}" r="17"/>
      <circle class="g-focus" cx="${p.x}" cy="${p.y}" r="16"/>
      <circle class="g-ring" cx="${p.x}" cy="${p.y}" r="12"/>
      <circle class="g-dot" cx="${p.x}" cy="${p.y}" r="8"/>
      <text class="g-label" x="${p.x + 18}" y="${p.y + 4}">${esc(gTruncate(d.student_name, labelChars))}</text>
      <text class="g-sublabel" x="${p.x + 18}" y="${p.y + 20}">Row ${d.source_row} · ${esc(gTruncate(d.source_file, labelChars - 6))}</text>
    </g>`;
  }).join('');

  canvas.classList.toggle('has-focus', Boolean(focus));
  canvas.classList.toggle('has-selection', Boolean(gx.selected));
  clearTimeout(gEnterTimer);
  canvas.classList.toggle('is-entering', animate && !motionOff());
  if (animate) gEnterTimer = setTimeout(() => canvas.classList.remove('is-entering'), 1600);
  canvas.innerHTML = `<svg viewBox="0 0 ${layout.width} ${layout.height}" width="${layout.width * gx.zoom}" height="${layout.height * gx.zoom}" role="group" aria-label="Integrity graph: institutions, source records and relationships. Use Tab or the arrow keys to move between items, Enter to inspect and Escape to clear the selection.">
    <defs><linearGradient id="gInstFill" x1="0" y1="0" x2="1" y2="1"><stop class="g-stop-a" offset="0"/><stop class="g-stop-b" offset="1"/></linearGradient></defs>
    ${bands}${rails}${edgeSvg}${instSvg}${recordSvg}${gx.sim ? `<text class="g-sim-watermark" x="${layout.width - 16}" y="${layout.height - 14}" text-anchor="end" aria-hidden="true">SIMULATION</text>` : ''}
  </svg>`;
  $('#gZoomLevel').textContent = `${Math.round(gx.zoom * 100)}%`;
}

function gRecordLabel(id) {
  const node = gx.view?.nodes.find(n => n.id === id);
  if (!node) return 'Record outside the current view';
  return `${node.detail.institution_code} row ${node.detail.source_row} · ${node.detail.student_name}`;
}

function gRenderTable() {
  const layout = gx.layout;
  const wrap = $('#gTableWrap');
  const focus = gFocusSets();
  let rows = layout.edges.filter(e => e.type !== 'source');
  if (focus?.matches) rows = rows.filter(e => focus.edges.has(e.id));
  if (!rows.length) {
    wrap.innerHTML = emptyState({ iconName: 'table', title: gx.query ? 'No relationships match this search' : 'No relationships match these filters', text: 'Adjust the search or filters to see persisted relationships.' });
    return;
  }
  wrap.innerHTML = `<table class="data-table stackable">
    <caption class="sr-only">Relationships between source records, backed by persisted findings</caption>
    <thead><tr><th scope="col">Relationship</th><th scope="col">Record A</th><th scope="col">Record B</th><th scope="col">Finding</th><th scope="col">Status</th><th scope="col" class="col-actions"><span class="sr-only">Actions</span></th></tr></thead>
    <tbody>${rows.map(edge => `
      <tr class="${gx.selected?.id === edge.id ? 'is-selected' : ''}">
        <td data-label="Relationship"><span class="rel-pill"><span class="legend-line ${edge.type}"></span>${esc(G_REL[edge.type].label)}</span></td>
        <td data-label="Record A">${esc(gRecordLabel(edge.source))}</td>
        <td data-label="Record B">${esc(gRecordLabel(edge.target))}</td>
        <td data-label="Finding" class="cell-wide"><div class="cell-title">${esc(edge.evidence?.title || 'Evidence unavailable')}</div><div class="cell-sub">${esc(ruleLabel(edge.evidence?.rule_code))}</div></td>
        <td data-label="Status">${edge.evidence ? statusBadge(edge.evidence.review_status) : '—'}</td>
        <td class="col-actions"><button type="button" class="btn btn-secondary btn-xs" data-inspect-edge="${esc(edge.id)}">Inspect${icon('chevron-right', 'icon-xs')}</button></td>
      </tr>`).join('')}</tbody>
  </table>`;
}

/* ── Evidence Panel ───────────────────────────── */
function gPanelHead(kicker, title, sub) {
  return `<div class="gp-head"><p class="gp-kicker">${kicker}</p><h2 class="gp-title">${esc(title)}</h2>${sub ? `<p class="gp-sub">${sub}</p>` : ''}</div>`;
}

function gFindingCard(f) {
  return `<div class="gp-finding">
    <div class="drawer-badges" style="margin:0">
      <span class="rel-pill"><span class="legend-line ${f.type}"></span>${esc(G_REL[f.type]?.label || f.type)}</span>
    </div>
    <p class="gp-finding-title">${esc(f.title)}</p>
    <div class="drawer-badges" style="margin-bottom:8px">${sevBadge(f.severity)}${statusBadge(f.review_status)}</div>
    <p>${esc(f.current_assessment?.summary || f.explanation)}</p>
    ${f.current_assessment?.stale_original ? `<p class="subtle" style="font-size:12px">As raised on ${esc(fmtDate(f.current_assessment.raised_at))} (no longer current): ${esc(f.explanation)}</p>` : ''}
    <dl class="gp-kv" style="margin-top:10px">
      <dt>Rule</dt><dd>${esc(ruleLabel(f.rule_code))}</dd>
      <dt>Matched</dt><dd>${esc(f.matched_fields.join(', ') || 'Not applicable')}</dd>
      <dt>Conflicting</dt><dd>${esc(f.conflicting_fields.join(', ') || 'None recorded')}</dd>
    </dl>
    <p class="gp-kicker" style="margin:10px 0 2px">Linked source records</p>
    <ul class="gp-records">${f.records.map(r => {
      const node = gx.view.nodes.find(n => n.type === 'record' && n.detail.institution_code === r.institution_code && n.detail.source_row === r.source_row && n.detail.source_file === r.source_file);
      const text = `${r.institution_code} row ${r.source_row} · ${r.student_name} · APAAR ${r.apaar_id}`;
      return `<li>${node ? `<button type="button" data-select-node="${esc(node.id)}">${esc(text)}</button>` : esc(text)}</li>`;
    }).join('')}</ul>
    <a class="btn btn-secondary btn-xs" style="margin-top:10px" href="#/reconciliation?finding=${esc(f.id)}">Open full finding${icon('arrow-right', 'icon-xs')}</a>
  </div>`;
}

function gRenderPanel() {
  const panel = $('#gPanel');
  const layout = gx.layout;
  const sel = gx.selected;

  if (!sel) {
    const counts = type => layout.edges.filter(e => e.type === type).length;
    panel.innerHTML = gPanelHead(`${icon('eye', 'icon-xs')}Evidence panel`, 'Select a record or relationship', 'Every node and edge links back to persisted source evidence.') + `
      <div class="gp-body">
        <div class="gp-block"><h4>In this view</h4>
          <dl class="gp-kv">
            <dt>Exact identifier</dt><dd>${counts('exact')}</dd>
            <dt>Candidate</dt><dd>${counts('candidate')} <span class="subtle">(uncertain)</span></dd>
            <dt>Identity conflict</dt><dd>${counts('conflict')}</dd>
            <dt>Source links</dt><dd>${counts('source')}</dd>
          </dl>
        </div>
        <div class="gp-block"><h4>How to read it</h4>
          <p class="muted">Columns are institutions. Each shaded band is one group of linked records. Solid lines are exact identifier matches, dashed lines are uncertain candidate matches and dotted red lines are identity conflicts.</p>
        </div>
        <div class="callout">${icon('shield')}<div>Relationships are review signals. None is proof of misconduct, and no identity has been verified against a government system.</div></div>
        <div class="gp-block"><h4>Find any student record</h4>
          <p class="muted">The graph shows records involved in a finding. Every other record, including earlier versions, can be found here.</p>
          ${hxRecordSearchHtml('')}
        </div>
      </div>`;
    hxBindRecordSearch(panel, '');
    return;
  }

  if (sel.kind === 'node') {
    const node = gx.view.nodes.find(n => n.id === sel.id);
    if (!node) { gx.selected = null; gRenderPanel(); return; }
    if (node.type === 'institution') {
      const records = layout.records.filter(r => r.institution_code === node.institution_code);
      panel.innerHTML = gPanelHead(`${icon('building', 'icon-xs')}Institution`, `${node.institution_code} · ${node.institution_name}`, `${plural(records.length, 'source record')} with relationships in the current view`) + `
        <div class="gp-body"><div class="gp-block"><h4>In the graph</h4>
          <ul class="gp-records">${records.map(r => `<li><button type="button" data-select-node="${esc(r.id)}">Row ${r.detail.source_row} · ${esc(r.detail.student_name)}</button>
            <div class="subtle">${esc([...new Set(r.detail.findings.map(f => G_REL[f.type]?.label))].join(', '))}</div></li>`).join('') || '<li class="muted">None in the current view.</li>'}</ul>
        </div>
        <div class="gp-block"><h4>All ${esc(node.institution_code)} source records</h4>${hxRecordSearchHtml(node.institution_code)}</div></div>`;
      hxBindRecordSearch(panel, node.institution_code);
      return;
    }
    const d = node.detail;
    panel.innerHTML = gPanelHead(`${icon('file', 'icon-xs')}Source record`, d.student_name, `${esc(d.institution_code)} · Row ${d.source_row} · ${esc(d.source_file)}`) + `
      <div class="gp-body">
        <dl class="gp-kv">
          <dt>Institution</dt><dd>${esc(d.institution_code)}</dd>
          <dt>Programme</dt><dd>${esc(d.programme)}</dd>
          <dt>Session</dt><dd>${esc(d.academic_session)}</dd>
          <dt>Enrolment</dt><dd>${esc(d.enrolment_status)}</dd>
          <dt>APAAR</dt><dd class="mono">${esc(d.apaar_id)}</dd>
          <dt>Source batch</dt><dd>${esc(d.source_batch)}</dd>
        </dl>
        <button type="button" class="btn btn-primary btn-xs" data-history="${esc(d.id)}">${icon('history', 'icon-xs')}Student history</button>
        <a class="btn btn-secondary btn-xs" href="${routeHash('profile', { record: d.id })}">${icon('users', 'icon-xs')}Open student profile</a>
        <div class="gp-block"><h4>${plural(d.findings.length, 'linked finding')}</h4>${d.findings.map(gFindingCard).join('')}</div>
      </div>`;
    return;
  }

  const edge = layout.edges.find(e => e.id === sel.id);
  if (!edge) { gx.selected = null; gRenderPanel(); return; }
  if (edge.sim) { gRenderSimEdgePanel(edge); return; }
  if (edge.type === 'source') {
    const ev = edge.evidence || {};
    panel.innerHTML = gPanelHead(`${icon('link', 'icon-xs')}Relationship`, G_REL.source.label, '') + `
      <div class="gp-body">
        <p class="muted">${esc(G_REL.source.note)}</p>
        <dl class="gp-kv">
          <dt>Institution</dt><dd>${esc(ev.institution_code)}</dd>
          <dt>Source file</dt><dd>${esc(ev.source_file)}</dd>
          <dt>Source row</dt><dd>${esc(ev.source_row)}</dd>
          <dt>Batch</dt><dd>${esc(ev.source_batch)}</dd>
        </dl>
        <button type="button" class="btn btn-secondary btn-xs" data-select-node="${esc(edge.target)}">Inspect the source record${icon('arrow-right', 'icon-xs')}</button>
      </div>`;
    return;
  }

  if (['confirmed', 'rejected', 'withdrawn'].includes(edge.type)) {
    const ev = edge.evidence || {};
    const recordId = gx.view.nodes.find(n => n.id === edge.source)?.detail.id;
    panel.innerHTML = gPanelHead(`${icon('link', 'icon-xs')}Relationship`, G_REL[edge.type].label, `${esc(gRecordLabel(edge.source))} ↔ ${esc(gRecordLabel(edge.target))}`) + `
      <div class="gp-body">
        <div class="callout ${edge.type === 'withdrawn' ? 'danger' : 'info'}">${icon(edge.type === 'withdrawn' ? 'alert-triangle' : 'info')}<div>${esc(G_REL[edge.type].note)}</div></div>
        <dl class="gp-kv">
          ${ev.decision ? `<dt>Decision</dt><dd>${esc(ev.decision.decision.replaceAll('_', ' '))}</dd><dt>User</dt><dd>${esc(ev.decision.reviewer)}</dd><dt>Recorded</dt><dd>${esc(fmtDate(ev.decision.at))}</dd><dt>Note</dt><dd>${esc(ev.decision.note || '—')}</dd>` : ''}
          ${ev.withdrawn ? `<dt>Withdrawn</dt><dd>${esc(fmtDate(ev.withdrawn.at))}</dd><dt>Reason</dt><dd>${esc(ev.withdrawn.reason || '')}</dd>` : ''}
        </dl>
        <div class="gp-actions"><a class="btn btn-secondary btn-xs" href="${routeHash('matches', { match: edge.link_id })}">Open the comparison${icon('arrow-right', 'icon-xs')}</a>
        ${recordId ? `<button type="button" class="btn btn-primary btn-xs" data-history="${esc(recordId)}">${icon('history', 'icon-xs')}Student history</button>` : ''}</div>
      </div>`;
    return;
  }
  const source = gx.view.nodes.find(n => n.id === edge.source);
  const finding = [...(source?.detail.findings || []), ...(gx.view.nodes.find(n => n.id === edge.target)?.detail.findings || [])].find(f => f.id === edge.finding_id);
  const toneClass = edge.type === 'candidate' ? 'warning' : edge.type === 'conflict' ? 'danger' : 'info';
  panel.innerHTML = gPanelHead(`${icon('link', 'icon-xs')}Relationship`, G_REL[edge.type].label, `${esc(gRecordLabel(edge.source))} ↔ ${esc(gRecordLabel(edge.target))}`) + `
    <div class="gp-body">
      <div class="callout ${toneClass}">${icon(edge.type === 'candidate' ? 'help' : edge.type === 'conflict' ? 'alert-triangle' : 'info')}<div>${esc(G_REL[edge.type].note)}</div></div>
      ${edge.type === 'exact' ? '' : `<button type="button" class="btn btn-primary btn-xs" data-compare-edge="${esc(edge.id)}">${icon('columns', 'icon-xs')}Compare side by side</button>`}
      ${finding ? `<div class="gp-block"><h4>Supporting persisted finding</h4>${gFindingCard(finding)}</div>`
        : `<div class="callout">${icon('info')}<div>No persisted finding was returned for this edge, so its supporting evidence cannot be shown.</div></div>`}
    </div>`;
}

/* Opens the potential-match comparison for a candidate or conflict edge. The pair is looked up
   in the server's queue by finding and record ids, so only a real persisted link can open. */
async function gCompareEdge(button) {
  const edge = gx.layout.edges.find(e => e.id === button.dataset.compareEdge);
  const recordOf = id => gx.view.nodes.find(n => n.id === id)?.detail.id;
  const pair = [recordOf(edge?.source), recordOf(edge?.target)];
  button.disabled = true;
  try {
    const { data } = await api('/api/v1/matches');
    const match = data.find(m => m.finding_id === edge.finding_id && pair.every(id => m.sources.some(s => s.record_id === id)));
    if (match) go('matches', { match: match.id });
    else toast('This relationship has no potential-match pair to compare, for example because its finding groups more than two records under one identifier. Open the full finding instead.', { tone: 'info', title: 'No comparison available' });
  } catch (error) {
    toast(error.message, { tone: 'error', title: 'Comparison unavailable' });
  } finally {
    button.disabled = false;
  }
}

/* ── Simulation overlay ───────────────────────── */
/* The overlay is merged into a copy of the server's graph for drawing only. Real edges the simulation
   annotates keep their own type; hypothetical edges get the 'simulated' type and their own style. */
function gMerge() {
  if (!gx.data || !gx.sim) return gx.data;
  const nodes = [...gx.data.nodes];
  const have = new Set(nodes.map(n => n.id));
  gx.sim.nodes.forEach(n => { if (!have.has(n.id)) { nodes.push({ ...n, sim_added: n.type === 'record' }); have.add(n.id); } });
  const marks = new Map(gx.sim.edges.filter(e => e.authoritative_edge_id).map(e => [e.authoritative_edge_id, e]));
  const edges = gx.data.edges.map(e => (marks.has(e.id) ? { ...e, sim: marks.get(e.id) } : e));
  gx.sim.nodes.filter(n => n.type === 'record' && !gx.data.nodes.some(m => m.id === n.id))
    .forEach(n => edges.push({ id: `sim-source:${n.id}`, source: `institution:${n.institution_code}`, target: n.id, type: 'source', evidence: { institution_code: n.institution_code, source_file: n.detail?.source_file, source_row: n.detail?.source_row, source_batch: n.detail?.source_batch } }));
  gx.sim.edges.filter(e => e.change === 'added').forEach(e => edges.push({ id: e.id, source: e.source, target: e.target, type: 'simulated', sim: e, evidence: e.evidence }));
  return { ...gx.data, nodes, edges };
}

function gShowSimulation(overlay) {
  gx.sim = overlay;
  gx.selected = overlay ? { kind: 'node', id: overlay.focus } : null;
  if (gx.data) { gx.view = gMerge(); gx.layout = gLayout(gx.view); if (state.view === 'graph') gRenderAll(); }
  gRenderSimBar();
}

/* Exit: the overlay is dropped and the graph is drawn again from the unchanged server data. */
function gExitSimulation({ silent = false } = {}) {
  const had = Boolean(gx.sim);
  gx.sim = null;
  gx.view = gx.data;
  if (had && gx.data) { gx.selected = null; gx.layout = gLayout(gx.view); if (state.view === 'graph') gRenderAll(); }
  gRenderSimBar();
  if (had && !silent) toast('The simulation overlay was removed. The graph shows only persisted relationships.', { title: 'Authoritative graph' });
}

function gRenderSimBar() {
  $('#gSimBar').hidden = !gx.sim;
  $('#gCanvas').classList.toggle('is-simulation', Boolean(gx.sim));
}

function gRenderSimEdgePanel(edge) {
  const sim = edge.sim; const link = sim.evidence?.link; const before = sim.evidence?.link_before;
  const fields = l => (l ? `<dt>Outcome</dt><dd>${esc(LAB_OUTCOME[l.outcome] || l.outcome)}</dd><dt>Agree</dt><dd>${esc(l.agreeing_fields.join(', ') || 'none')}</dd><dt>Conflict</dt><dd>${esc(l.conflicting_fields.join(', ') || 'none')}</dd><dt>Missing</dt><dd>${esc(l.missing_fields.join(', ') || 'none')}</dd><dt>Policy</dt><dd>${esc(l.policy_version)}</dd>` : '');
  $('#gPanel').innerHTML = gPanelHead(`${icon('flask', 'icon-xs')}Simulation`, `${G_REL[sim.relationship]?.label || sim.relationship} ${G_SIM_CHANGE[sim.change]}`, `${esc(gRecordLabel(edge.source))} ↔ ${esc(gRecordLabel(edge.target))}`) + `
    <div class="gp-body">
      <div class="callout warning">${icon('flask')}<div><strong>SIMULATION ONLY — NO AUTHORITATIVE RECORD CHANGED.</strong> ${esc(sim.change === 'added' ? G_REL.simulated.note : 'This is a real, persisted relationship. The annotation shows what the staged correction would do to it in an isolated copy.')}</div></div>
      ${sim.evidence?.title ? `<div class="gp-block"><h4>Rule outcome${sim.change === 'removed' ? ' (current)' : ' (simulated)'}</h4><p><strong>${esc(sim.evidence.title)}</strong></p><p class="muted">${esc(sim.evidence.current_assessment?.summary || sim.evidence.explanation || '')}</p><dl class="gp-kv"><dt>Rule</dt><dd>${esc(ruleLabel(sim.evidence.rule_code))}</dd><dt>Status</dt><dd>${esc(statusLabel(sim.evidence.review_status || 'pending'))}</dd></dl></div>` : ''}
      ${before ? `<div class="gp-block"><h4>Pair evidence now</h4><dl class="gp-kv">${fields(before)}</dl></div>` : ''}
      ${link ? `<div class="gp-block"><h4>Pair evidence ${sim.change === 'removed' ? 'now' : 'in the simulation'}</h4><dl class="gp-kv">${fields(link)}</dl><p class="muted">${esc(link.reason)}</p></div>` : ''}
      <div class="gp-actions"><button type="button" class="btn btn-secondary btn-xs" data-g-sim-back>${icon('arrow-left', 'icon-xs')}Back to the lab</button></div>
    </div>`;
}

$('#gSimExit').addEventListener('click', () => { gExitSimulation(); if (typeof labDiscard === 'function') labDiscard(); });
$('#gSimBack').addEventListener('click', () => { if (lab.context) labOpen(lab.context, $('#gSimBack')); });

/* ── Interaction ──────────────────────────────── */
/* Update focus classes on the existing SVG instead of rebuilding it, so the
   dimming of unrelated items and the selection ring transition smoothly. */
function gApplyFocus() {
  const canvas = $('#gCanvas');
  const svg = $('svg', canvas);
  if (!svg) return false;
  const focus = gFocusSets();
  canvas.classList.toggle('has-focus', Boolean(focus));
  canvas.classList.toggle('has-selection', Boolean(gx.selected));
  $$('[data-node]', svg).forEach(el => {
    el.classList.toggle('is-hot', Boolean(focus?.nodes.has(el.dataset.node)));
    el.classList.toggle('is-selected', gx.selected?.kind === 'node' && gx.selected.id === el.dataset.node);
  });
  $$('[data-edge]', svg).forEach(el => {
    el.classList.toggle('is-hot', Boolean(focus?.edges.has(el.dataset.edge)));
    el.classList.toggle('is-selected', gx.selected?.kind === 'edge' && gx.selected.id === el.dataset.edge);
  });
  return true;
}

function gSelect(selection) {
  gx.selected = selection;
  if (gx.mode === 'table') gRenderTable();
  else if (!gApplyFocus()) gRenderSvg();
  gRenderPanel();
  if (selection && gx.mode === 'graph') {
    const el = $(`#gCanvas [data-${selection.kind}="${CSS.escape(selection.id)}"]`);
    el?.focus({ preventScroll: true });
    el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
  if (selection && mobileQuery.matches) $('#gPanel').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function gApplyMode() {
  const table = gx.mode === 'table';
  $('#gModeGraph').setAttribute('aria-pressed', String(!table));
  $('#gModeTable').setAttribute('aria-pressed', String(table));
  $('#gCanvas').hidden = table;
  $('#gTableWrap').hidden = !table;
  $('#gZoom').hidden = table;
}

function gClearFilters() {
  ['#gInstitution', '#gRelationship', '#gStatus'].forEach(id => { $(id).value = ''; });
  gLoad();
}

function gSetZoom(value) {
  gx.zoom = Math.min(1.6, Math.max(0.6, Math.round(value * 10) / 10));
  const svg = $('#gCanvas svg');
  if (svg && gx.layout) {
    svg.setAttribute('width', gx.layout.width * gx.zoom);
    svg.setAttribute('height', gx.layout.height * gx.zoom);
  }
  $('#gZoomLevel').textContent = `${Math.round(gx.zoom * 100)}%`;
  $('#gZoomOut').disabled = gx.zoom <= 0.6;
  $('#gZoomIn').disabled = gx.zoom >= 1.6;
}

$('#gCanvas').addEventListener('click', event => {
  const node = event.target.closest('[data-node]');
  if (node) { gSelect(gx.selected?.id === node.dataset.node ? null : { kind: 'node', id: node.dataset.node }); return; }
  const edge = event.target.closest('[data-edge]');
  if (edge) { gSelect(gx.selected?.id === edge.dataset.edge ? null : { kind: 'edge', id: edge.dataset.edge }); return; }
  if (event.target.closest('svg') && gx.selected) gSelect(null);
});

$('#gCanvas').addEventListener('keydown', event => {
  if (event.key === 'Escape' && gx.selected) { event.stopPropagation(); gSelect(null); return; }
  if (['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
    const items = $$('#gCanvas [data-node]');
    if (!items.length) return;
    event.preventDefault();
    const index = items.indexOf(event.target.closest('[data-node]'));
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : index < 0 ? 0 : Math.min(Math.max(index + (forward ? 1 : -1), 0), items.length - 1);
    items[next].focus();
    items[next].scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const target = event.target.closest('[data-node], [data-edge]');
  if (!target) return;
  event.preventDefault();
  target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
});

$('#gTableWrap').addEventListener('click', event => {
  const button = event.target.closest('[data-inspect-edge]');
  if (button) gSelect({ kind: 'edge', id: button.dataset.inspectEdge });
});

$('#gPanel').addEventListener('click', event => {
  const history = event.target.closest('[data-history]');
  if (history) { hxOpen(history.dataset.history, history); return; }
  if (event.target.closest('[data-g-sim-back]')) { if (lab.context) labOpen(lab.context, event.target.closest('[data-g-sim-back]')); return; }
  const compare = event.target.closest('[data-compare-edge]');
  if (compare) { gCompareEdge(compare); return; }
  const button = event.target.closest('[data-select-node]');
  if (!button) return;
  if (gx.mode === 'table') { gx.mode = 'graph'; gApplyMode(); }
  gSelect({ kind: 'node', id: button.dataset.selectNode });
});

$('#gSearchForm').addEventListener('submit', event => {
  event.preventDefault();
  gx.query = gNormal($('#gQuery').value);
  gx.selected = null;
  if (gx.layout) gRenderAll();
});
$('#gQuery').addEventListener('input', () => { $('#gClearQuery').hidden = !$('#gQuery').value; });
$('#gClearQuery').addEventListener('click', () => {
  $('#gQuery').value = '';
  $('#gClearQuery').hidden = true;
  gx.query = '';
  if (gx.layout) gRenderAll();
  $('#gQuery').focus();
});

['#gInstitution', '#gRelationship', '#gStatus'].forEach(id => $(id).addEventListener('change', gLoad));

$('#gModeGraph').addEventListener('click', () => { gx.mode = 'graph'; gApplyMode(); if (gx.layout) gRenderAll(); });
$('#gModeTable').addEventListener('click', () => { gx.mode = 'table'; gApplyMode(); if (gx.layout) gRenderAll(); });

$('#gZoomIn').addEventListener('click', () => gSetZoom(gx.zoom + 0.2));
$('#gZoomOut').addEventListener('click', () => gSetZoom(gx.zoom - 0.2));
$('#gReset').addEventListener('click', () => {
  gSetZoom(1);
  gx.selected = null;
  if (gx.layout) gRenderAll();
  $('#gCanvas').scrollTo({ top: 0, left: 0 });
});

/* Re-fit columns to the canvas when the viewport changes */
let gResizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(gResizeTimer);
  gResizeTimer = setTimeout(() => {
    if (state.view !== 'graph' || !gx.data || gx.mode !== 'graph') return;
    gx.layout = gLayout(gx.view);
    gRenderSvg();
  }, 150);
});
