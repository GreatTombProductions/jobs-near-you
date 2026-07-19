// Jobs Near You — client app
// MD5-sharded detail data with industry breakdown, age/earnings distributions
// Three search modes: county name, state browse, proximity

(function () {
  'use strict';

  const $ = (sel, ctx) => (ctx || document).querySelector(sel);
  const $$ = (sel, ctx) => [...(ctx || document).querySelectorAll(sel)];

  const DATA_BASE = 'data';

  // ── State ──
  let meta = null;
  let searchCache = {};
  let detailCache = {};
  let stateCache = {};
  let proxCache = null;
  let lastResults = [];

  // ── Formatting ──
  function fmtJobs(val) {
    if (val == null) return '—';
    if (val >= 1e6) return (val / 1e6).toFixed(1) + 'M';
    if (val >= 1000) return (val / 1000).toFixed(1) + 'K';
    return val.toLocaleString();
  }

  function fmtJobsCompact(val) {
    if (val == null) return '—';
    if (val >= 1e6) return (val / 1e6).toFixed(2) + ' million';
    if (val >= 1000) return (val / 1000).toFixed(1) + ' thousand';
    return val.toLocaleString();
  }

  function fmtPct(val, total) {
    if (!total) return '0%';
    return ((val / total) * 100).toFixed(1) + '%';
  }

  // ── Init ──
  async function init() {
    try {
      const resp = await fetch(`${DATA_BASE}/meta.json`);
      meta = await resp.json();
      renderIntro();
      populateStates();
      populateRadius();
    } catch (e) {
      console.error('Failed to load meta:', e);
      $('#intro-stats').innerHTML = '<p>Loading data…</p>';
    }
  }

  function renderIntro() {
    if (!meta) return;
    const jobsStr = meta.total_jobs_us
      ? (meta.total_jobs_us / 1e6).toFixed(1) + ' million'
      : '—';
    const medianStr = meta.median_county_jobs
      ? fmtJobs(meta.median_county_jobs)
      : '—';
    const yearNote = meta.data_year_note || meta.data_year;
    $('#intro-stats').innerHTML = `
      <div class="stat"><span class="stat-value">${meta.total_counties ? meta.total_counties.toLocaleString() : '—'}</span> counties</div>
      <div class="stat"><span class="stat-value">${jobsStr}</span> total U.S. jobs (${yearNote})</div>
      <div class="stat"><span class="stat-value">${medianStr}</span> national median county jobs</div>
      <p class="intro-text">The Census Bureau's LEHD Origin-Destination Employment Statistics (LODES) tracks jobs by workplace location at the census block level. This tool aggregates block-level data to counties, showing industry breakdowns, worker age distribution, and earnings patterns. Search by county name, browse by state, or find job data near any address. Data from ${meta.data_year}.</p>
    `;
  }

  async function populateStates() {
    try {
      const states = meta.states || [];
      const sel = $('#state-select');
      // State abbrev → name lookup from meta
      states.sort().forEach(s => {
        const opt = document.createElement('option');
        opt.value = s;
        opt.textContent = s;
        sel.appendChild(opt);
      });
    } catch (e) {
      console.error('Failed to populate states:', e);
    }
  }

  function populateRadius() {
    const sel = $('#radius-select');
    [5, 10, 25, 50, 100].forEach(r => {
      const opt = document.createElement('option');
      opt.value = r;
      opt.textContent = r + ' miles';
      if (r === 25) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  // ── Tab switching ──
  $$('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      $$('.search-panel').forEach(p => p.classList.remove('active'));
      $(`#${btn.dataset.tab}-search`).classList.add('active');
    });
  });

  // ── Name search ──
  let searchTimeout = null;
  $('#search-input').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    const q = $('#search-input').value.trim();
    if (q.length < 1) {
      $('#search-results').innerHTML = '';
      return;
    }
    searchTimeout = setTimeout(() => doNameSearch(q), 150);
  });

  async function doNameSearch(q) {
    const first = q[0].toLowerCase();
    if (!/[a-z]/.test(first)) return;

    const shard = `search_${first.toUpperCase()}.json`;
    if (!searchCache[first]) {
      try {
        const resp = await fetch(`${DATA_BASE}/search/${shard}`);
        searchCache[first] = await resp.json();
      } catch (e) {
        $('#search-results').innerHTML = '<p class="no-results">No results.</p>';
        return;
      }
    }

    const data = searchCache[first];
    const qLower = q.toLowerCase();
    let matches = data.filter(c =>
      c.n.toLowerCase().includes(qLower)
    );

    matches.sort((a, b) => {
      const aStarts = a.n.toLowerCase().startsWith(qLower);
      const bStarts = b.n.toLowerCase().startsWith(qLower);
      if (aStarts && !bStarts) return -1;
      if (!aStarts && bStarts) return 1;
      return a.n.localeCompare(b.n);
    });

    lastResults = matches.slice(0, 50);
    renderSearchResults(lastResults);
  }

  function renderSearchResults(results) {
    if (!results.length) {
      $('#search-results').innerHTML = '<p class="no-results">No counties found.</p>';
      return;
    }
    let html = '';
    results.forEach(c => {
      html += `<div class="result-card" data-fips="${c.f}">
        <div class="result-name">${c.n}, ${c.s}</div>
        <div class="result-meta">Jobs: <strong>${fmtJobs(c.t)}</strong></div>
      </div>`;
    });
    $('#search-results').innerHTML = html;
    $$('.result-card', $('#search-results')).forEach(card => {
      card.addEventListener('click', () => loadDetail(card.dataset.fips));
    });
  }

  // ── State browse ──
  $('#state-select').addEventListener('change', async () => {
    const state = $('#state-select').value;
    if (!state) {
      $('#state-results').innerHTML = '';
      return;
    }
    if (!stateCache[state]) {
      try {
        const resp = await fetch(`${DATA_BASE}/states/state_${state}.json`);
        stateCache[state] = await resp.json();
      } catch (e) {
        $('#state-results').innerHTML = '<p class="no-results">No data for this state.</p>';
        return;
      }
    }
    const data = stateCache[state];
    lastResults = data.counties;
    renderStateResults(data);
  });

  function renderStateResults(data) {
    let html = `<h3>${data.state_name} — ${data.counties.length} counties, ranked by total jobs</h3>
      <p class="state-total">State total: <strong>${fmtJobs(data.total_jobs)}</strong> jobs</p>`;
    if (!data.counties.length) {
      html += '<p class="no-results">No counties found.</p>';
      $('#state-results').innerHTML = html;
      return;
    }
    data.counties.forEach((c, i) => {
      html += `<div class="result-card" data-fips="${c.f}">
        <div class="result-rank">${i + 1}.</div>
        <div class="result-info">
          <div class="result-name">${c.n}</div>
          <div class="result-meta">Jobs: <strong>${fmtJobs(c.t)}</strong></div>
        </div>
      </div>`;
    });
    $('#state-results').innerHTML = html;
    $$('.result-card', $('#state-results')).forEach(card => {
      card.addEventListener('click', () => loadDetail(card.dataset.fips));
    });
  }

  // ── Proximity search ──
  $('#nearby-btn').addEventListener('click', doNearbySearch);
  $('#addr-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') doNearbySearch();
  });

  async function doNearbySearch() {
    const addr = $('#addr-input').value.trim();
    if (!addr) return;
    $('#nearby-results').innerHTML = '<p class="loading">Geocoding address…</p>';

    try {
      const geoResp = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(addr)}&limit=1&countrycodes=us`
      );
      const geoData = await geoResp.json();
      if (!geoData.length) {
        $('#nearby-results').innerHTML = '<p class="no-results">Address not found. Try a city name or ZIP code.</p>';
        return;
      }

      const lat = parseFloat(geoData[0].lat);
      const lon = parseFloat(geoData[0].lon);
      const displayName = geoData[0].display_name;
      const radius = parseFloat($('#radius-select').value);

      $('#nearby-results').innerHTML = `<p class="loading">Searching within ${radius} miles of ${displayName.split(',')[0]}…</p>`;

      // Load proximity data
      if (!proxCache) {
        try {
          const resp = await fetch(`${DATA_BASE}/proximity/proximity.json`);
          proxCache = await resp.json();
        } catch (e) {
          $('#nearby-results').innerHTML = '<p class="no-results">Proximity data unavailable.</p>';
          return;
        }
      }

      const nearby = [];
      for (const c of proxCache) {
        if (!c.lat || !c.lon) continue;
        const d = haversineKm(lat, lon, c.lat, c.lon);
        const dMi = d * 0.621371;
        if (dMi <= radius) {
          nearby.push({ ...c, distance: dMi });
        }
      }

      nearby.sort((a, b) => a.distance - b.distance);
      lastResults = nearby.slice(0, 50);
      renderProxResults(nearby.slice(0, 50), displayName);
    } catch (e) {
      console.error(e);
      $('#nearby-results').innerHTML = '<p class="no-results">Search failed. Try again.</p>';
    }
  }

  function renderProxResults(results, addr) {
    if (!results.length) {
      $('#nearby-results').innerHTML = '<p class="no-results">No counties found within this radius. Try a larger radius.</p>';
      return;
    }
    let html = `<h3>Near ${addr.split(',')[0]}</h3>`;
    results.forEach(c => {
      html += `<div class="result-card" data-fips="${c.f}">
        <div class="result-rank">${c.distance.toFixed(1)} mi</div>
        <div class="result-info">
          <div class="result-name">${c.n}, ${c.s}</div>
          <div class="result-meta">Jobs: <strong>${fmtJobs(c.t)}</strong></div>
        </div>
      </div>`;
    });
    $('#nearby-results').innerHTML = html;
    $$('.result-card', $('#nearby-results')).forEach(card => {
      card.addEventListener('click', () => loadDetail(card.dataset.fips));
    });
  }

  // ── Detail view ──
  async function loadDetail(fips) {
    const shard = md5(fips).substring(0, 2);
    const cacheKey = `${shard}_${fips}`;

    if (!detailCache[shard]) {
      try {
        const resp = await fetch(`${DATA_BASE}/details/detail_${shard}.json`);
        detailCache[shard] = await resp.json();
      } catch (e) {
        console.error('Failed to load detail:', e);
        return;
      }
    }

    const detail = detailCache[shard][fips];
    if (!detail) return;

    currentDetail = { fips, detail };
    renderDetail(detail);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderDetail(d) {
    const totalJobs = d.t;
    const natIndustry = meta && meta.national_industry ? meta.national_industry : {};

    let industryHtml = '';
    if (d.ind && d.ind.length) {
      // Show top 8 industries + rest
      const top = d.ind.slice(0, 8);
      const rest = d.ind.slice(8);
      const restTotal = rest.reduce((s, x) => s + x.jobs, 0);

      top.forEach(item => {
        const pct = fmtPct(item.jobs, totalJobs);
        const natPct = natIndustry[item.code] && meta.total_jobs_us
          ? (natIndustry[item.code].jobs / meta.total_jobs_us * 100).toFixed(1) + '%'
          : null;
        industryHtml += `
          <div class="industry-row">
            <div class="industry-label">${item.label}</div>
            <div class="industry-bar-wrap">
              <div class="industry-bar" style="width:${Math.min(pct * 3, 100)}%"></div>
            </div>
            <div class="industry-val">${fmtJobs(item.jobs)} <span class="pct">(${pct})</span>${natPct ? ' <span class="nat">vs ' + natPct + ' nationally</span>' : ''}</div>
          </div>`;
      });

      if (restTotal > 0) {
        const restPct = fmtPct(restTotal, totalJobs);
        industryHtml += `
          <div class="industry-row">
            <div class="industry-label">Other industries (${rest.length})</div>
            <div class="industry-bar-wrap">
              <div class="industry-bar industry-bar-other" style="width:${Math.min(restPct * 3, 100)}%"></div>
            </div>
            <div class="industry-val">${fmtJobs(restTotal)} <span class="pct">(${restPct})</span></div>
          </div>`;
      }
    }

    // Age distribution
    let ageHtml = '';
    if (d.age) {
      d.age.forEach(item => {
        const pct = fmtPct(item.jobs, totalJobs);
        ageHtml += `
          <div class="stat-row">
            <span>${item.label}</span>
            <span>${fmtJobs(item.jobs)} (${pct})</span>
          </div>`;
      });
    }

    // Earnings distribution
    let earningsHtml = '';
    if (d.earn) {
      d.earn.forEach(item => {
        const pct = fmtPct(item.jobs, totalJobs);
        earningsHtml += `
          <div class="stat-row">
            <span>${item.label}</span>
            <span>${fmtJobs(item.jobs)} (${pct})</span>
          </div>`;
      });
    }

    // National comparison
    const natMedian = meta ? meta.median_county_jobs : 0;
    const vsNat = natMedian ? ((totalJobs / natMedian - 1) * 100).toFixed(0) : null;
    const vsNatStr = vsNat !== null
      ? (vsNat > 0 ? '+' + vsNat + '%' : vsNat + '%') + ' vs national median'
      : '';

    const html = `
      <div class="detail-card">
        <div class="detail-header">
          <button class="back-btn" onclick="window.history.back()">← Back</button>
          <h2>${d.n}, ${d.s}</h2>
          <div class="detail-total">${fmtJobs(totalJobs)} total jobs ${vsNatStr ? '<span class="vs-nat">(' + vsNatStr + ')</span>' : ''}</div>
        </div>

        <div class="detail-section">
          <h3>Industry Breakdown</h3>
          <p class="section-note">Workplace jobs by NAICS industry sector. Percentages show share of county jobs. National comparison shows each sector's share of all U.S. jobs.</p>
          ${industryHtml}
        </div>

        <div class="detail-grid">
          <div class="detail-section">
            <h3>Worker Age Distribution</h3>
            ${ageHtml}
          </div>
          <div class="detail-section">
            <h3>Monthly Earnings Distribution</h3>
            ${earningsHtml}
          </div>
        </div>

        <div class="detail-section detail-footer">
          <p>Data: Census LODES 8.4, ${meta ? meta.data_year : '2023'}. Workplace Area Characteristics (WAC) — jobs by work location, not residence.</p>
          <p><a href="https://lehd.ces.census.gov/data/lodes/LODES8/" target="_blank" rel="noopener">LEHD LODES data source</a></p>
        </div>
      </div>`;

    $('#detail-panel').innerHTML = html;
    $('#detail-panel').style.display = 'block';
    $$('.search-container')[0].style.display = 'none';

    $('#detail-panel').querySelector('.back-btn').addEventListener('click', (e) => {
      e.preventDefault();
      $('#detail-panel').style.display = 'none';
      $('#detail-panel').innerHTML = '';
      $$('.search-container')[0].style.display = 'block';
      currentDetail = null;
    });
  }

  // ── Haversine ──
  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // ── MD5 (pure JS) ──
  function md5(str) {
    function r(n, c) { return (n << c) | (n >>> (32 - c)); }
    function q(n, c) { return (n & c) | ((~n) & (0xFFFFFFFF - c)); }
    function p(n, c) { return (n & c) | (n & (0xFFFFFFFF - c)); }
    function o(n, c) { return n ^ c; }
    function s(x, y, z) { return x ^ y ^ z; }

    const bytes = [];
    for (let i = 0; i < str.length; i++) {
      bytes.push(str.charCodeAt(i) & 0xFF);
    }
    const origLen = bytes.length;
    bytes.push(0x80);
    while ((bytes.length % 64) !== 56) bytes.push(0);
    const bitLen = origLen * 8;
    for (let i = 0; i < 8; i++) {
      bytes.push((bitLen >>> (i * 8)) & 0xFF);
    }

    const T = [];
    for (let i = 0; i < 64; i++) T[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000);

    let a = 0x67452301, b = 0xEFCDAB89, c = 0x98BADCFE, d = 0x10325476;

    for (let bi = 0; bi < bytes.length; bi += 64) {
      const M = [];
      for (let i = 0; i < 16; i++) {
        M[i] = bytes[bi + i * 4] | (bytes[bi + i * 4 + 1] << 8) |
          (bytes[bi + i * 4 + 2] << 16) | (bytes[bi + i * 4 + 3] << 24);
      }

      let A = a, B = b, C = c, D = d;
      for (let i = 0; i < 64; i++) {
        let f, g;
        if (i < 16) { f = q(B, C, D); g = i; }
        else if (i < 32) { f = q(D, B, C); g = (5 * i + 1) % 16; }
        else if (i < 48) { f = s(B, C, D); g = (3 * i + 5) % 16; }
        else { f = o(C, q(B, 0xFFFFFFFF, D)); g = (7 * i) % 16; }
        const temp = D;
        D = C;
        C = B;
        B = B + r(A + f + T[i] + M[g], [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21][i]);
        A = temp;
      }
      a = (a + A) >>> 0; b = (b + B) >>> 0; c = (c + C) >>> 0; d = (d + D) >>> 0;
    }

    function toHex(v) {
      return ('0000000' + v.toString(16)).slice(-8);
    }
    return toHex(a) + toHex(b) + toHex(c) + toHex(d);
  }

  // ── Start ──
  init();
})();
