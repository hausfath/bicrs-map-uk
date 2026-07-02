/* ============================================================
   BiCRS Atlas — United Kingdom. Unified application logic.
   Tile-free thematic map (the choropleth IS the basemap); works offline by
   double-clicking index.html (no server). This is the UK subset of Frontier's
   BiCRS Atlas (https://github.com/hausfath/biomass_map): 41 NUTS-2 / ITL-2
   regions, sharing the Atlas's engine, data pipeline and rendering code, with
   a single UK scope. Data bundles are regenerated from the parent repo by
   scripts/build_uk_from_parent.py.
   ============================================================ */
(function () {
  "use strict";

  // ---- Shared constants ----
  const PATH_META = {
    beccs:     { label: "BECCS (heat/electricity)",   color: "#15967f" },
    beccs_pp:  { label: "BECCS — pulp & paper",        color: "#2cc0a4" },
    wte_ccs:   { label: "WtE + CCS",                   color: "#3b7dd8" },
    lfg_ccs:   { label: "Landfill gas + CCS",          color: "#d36b9a" },
    lfg_rng_ccs: { label: "Landfill-gas RNG + CCS",    color: "#9c5577" },
    injection: { label: "Biomass waste injection",     color: "#9b59d0" },
    bio_oil:   { label: "Bio-oil (pyrolysis)",         color: "#e08a2b" },
    bio_oil_htl: { label: "Bio-oil (HTL)",             color: "#e0b56b" },
    burial:    { label: "Biomass burial",              color: "#b07d3a" },
    ad_ccs:    { label: "Anaerobic digestion + CCS",   color: "#6b8a9c" },
    biochar:   { label: "Biochar",                     color: "#8aa53f" },
  };
  const FAC_META = {
    pulp_paper: { label: "Pulp & paper",       color: "#e0b020" },
    ethanol:    { label: "Ethanol",            color: "#d9772b" },
    wte:        { label: "Waste-to-energy",    color: "#c0556b" },
    bioenergy:  { label: "Bioenergy / power",  color: "#e8c64a" },
    biogas_ad:  { label: "Biogas / AD",        color: "#9aa84a" },
    landfill:   { label: "Landfill gas",       color: "#8a7d5a" },
  };
  const STORAGE_TYPE = {
    saline: "Saline aquifer", depleted_og: "Depleted oil & gas",
    basalt: "Basalt (mineralization)", eor: "Enhanced oil recovery",
  };
  const GREENS = ["#dbeecf", "#a6d7a0", "#6fbf73", "#3da35a", "#1f7a45", "#0d5530"];
  const NODATA = "#2a3742";

  const FEEDSTOCK_HINTS = {
    ag: "Recoverable crop residues (straw, stover, bagasse), Mt oven-dry/yr (~40% sustainable removal cap).",
    forestry: "Logging + processing residues, Mt oven-dry/yr.",
    msw_biogenic: "Biogenic fraction of municipal solid waste, Mt/yr — only the biogenic share counts as CDR.",
    manure: "Animal manure dry-matter, Mt/yr. Wet waste → injection / AD, not combustion.",
    wwtp: "Sewage sludge / biosolids dry solids, Mt/yr.",
  };
  const FEEDSTOCK_LABEL = {
    ag: "Agricultural residues", forestry: "Forestry residues",
    msw_biogenic: "MSW (biogenic)", manure: "Animal manure", wwtp: "Human / WWTP biosolids",
  };

  // ---- Generic helpers ----
  function fmt(v) {
    if (v == null) return "—";
    if (v >= 1000) return (v / 1000).toFixed(1) + "k";
    if (v >= 100) return v.toFixed(0);
    if (v >= 1) return v.toFixed(1);
    if (v >= 0.1) return v.toFixed(2);
    return v.toFixed(3);
  }
  function cap1(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : "—"; }
  function clamp(lo, v, hi) { return Math.max(lo, Math.min(hi, v)); }
  function num(o) { return (o && o.value != null) ? o.value : 0; }
  function rangeTxt(o) {
    if (!o || o.low == null || o.high == null) return "";
    return `(${fmt(o.low)}–${fmt(o.high)})`;
  }
  function labelFeed(d) {
    return ({ ag_dry: "Dry ag residues", forestry_woody: "Woody forestry", msw: "Municipal waste",
      manure_wet: "Wet manure", mixed: "Mixed" })[d] || d || "—";
  }
  function quantileBreaks(values, nColors) {
    const v = values.filter(x => x != null && x > 0).sort((a, b) => a - b);
    if (!v.length) return [];
    const breaks = [];
    for (let i = 1; i < nColors; i++) {
      const idx = Math.min(v.length - 1, Math.floor((i / nColors) * v.length));
      breaks.push(v[idx]);
    }
    return breaks;
  }
  function colorForValue(val, breaks) {
    if (val == null || val <= 0) return null;
    for (let i = 0; i < breaks.length; i++) if (val < breaks[i]) return GREENS[i];
    return GREENS[GREENS.length - 1];
  }
  function feedValue(feed, key) {
    if (!feed) return null;
    if (key === "msw_biogenic") return (feed.msw || 0) * (feed.biofrac || 0.5);
    const v = feed[key];
    return v != null ? v : null;
  }

  // ---- Ranked pros/cons reconstruction (US/EU; mirrors engine_core.region_pros_cons) ----
  // Mirrors engine_core.PATHWAY_PAYLOAD — the transport payload class per pathway. The landfill-gas
  // pathways move gaseous CO₂ (like BECCS/WtE), so they must be here too, else the frontend would
  // treat them as storage-independent (drawing the wrong route, hiding the transport cost).
  const PAYLOAD_OF = { beccs: "co2", beccs_pp: "co2", wte_ccs: "co2", ad_ccs: "co2", lfg_ccs: "co2", lfg_rng_ccs: "co2", bio_oil: "bio_oil", bio_oil_htl: "bio_oil_htl", injection: "slurry" };
  const TRANSPORT_CAP = 100;

  // Storage destination shown in the detail panel = the well/project the routed storage access is
  // actually based on (status-tiered: a firm well is preferred, a draft/pending one only as a
  // rescue), NOT the great-circle nearest well — which may be an unused draft/pending site, making
  // the panel inconsistent with the storage-access grade. Falls back to the great-circle nearest
  // (fallbackName/fallbackKm) for regions with no routed transport record.
  function storageDestination(rec, transportLookup, fallbackName, fallbackKm) {
    if (rec.transport_dest_well) {
      const t = transportLookup ? transportLookup(rec.id) : null;
      const st = (rec.transport_dest_status && rec.transport_dest_status !== "operational")
        ? ` · ${rec.transport_dest_status}` : "";
      // routed km to the destination the recommended pathway actually uses (CO₂-eligible well for
      // capture pathways — item 7); fall back to the general routed km where not separately stored.
      const km = (rec.transport_dest_km != null) ? rec.transport_dest_km
        : (t && t.total_km != null) ? t.total_km : null;
      return `${rec.transport_dest_well}${st}${km != null ? ` (~${fmt(km)} km routed)` : ""}`;
    }
    return fallbackName ? `${fallbackName}${fallbackKm != null ? ` (~${fallbackKm} km)` : ""}` : "—";
  }

  // ---- Delivered (all-in) cost = conversion (pathway cost_band) + transport-to-well (item 5) ----
  // Parse a PATHWAYS cost_band string ("$200-225 (to <$100 at scale)", "~$100-200", "<$100-150")
  // into a [low, high] conversion range; the parenthetical aspirational figure is ignored.
  function parseCostBand(band) {
    if (!band) return null;
    const nums = (band.split("(")[0].match(/\d+(?:\.\d+)?/g) || []).map(Number);
    if (!nums.length) return null;
    return [Math.min.apply(null, nums), Math.max.apply(null, nums)];
  }
  // All-in delivered $/tCO₂ for one pathway: conversion band + payload-weighted transport.
  // `transportUsd` is null for storage-independent pathways (burial/biochar — nothing hauled to a
  // well). Returns null if the conversion band can't be parsed (so callers fall back to cost_band).
  function deliveredCost(costBand, transportUsd) {
    const cv = parseCostBand(costBand);
    if (!cv) return null;
    const t = (transportUsd != null) ? transportUsd : 0;
    const lo = Math.round(cv[0] + t), hi = Math.round(cv[1] + t);
    return {
      lo: lo, hi: hi,
      range: lo === hi ? `$${lo}` : `$${lo}–${hi}`,
      conv: cv[0] === cv[1] ? `$${cv[0]}` : `$${cv[0]}–${cv[1]}`,
      transport: transportUsd,
    };
  }
  function regionProsCons(rec, key, profile) {
    const prof = profile[key];
    let pros = prof.pros.slice(), cons = prof.cons.slice();
    const sa = rec.storage_access, dens = rec.feedstock_density, nut = rec.nutrient_status;
    // transport-cost note (storage-dependent pathways, where a per-payload delivered cost is known)
    const tbp = rec.transport_by_payload, pay = PAYLOAD_OF[key];
    const tc = (tbp && pay) ? tbp[pay] : null;
    if (tc != null) {
      if (tc > TRANSPORT_CAP) cons.unshift(`Transport to the nearest operating well ~$${fmt(tc)}/tCO₂ — exceeds the $${TRANSPORT_CAP}/tCO₂ viability cap, so this pathway is not viable here`);
      else if (tc >= 66) cons.push(`Transport to the nearest operating well is costly (~$${fmt(tc)}/tCO₂)`);
    }
    const central = key === "beccs" || key === "beccs_pp" || key === "wte_ccs";
    const distributed = key === "bio_oil" || key === "bio_oil_htl" || key === "biochar" || key === "burial";
    if (prof.needs_storage) {
      if (sa === "good") pros.push("Proximate geologic storage here" + (rec.nearest_storage_km != null ? ` (~${rec.nearest_storage_km} km)` : ""));
      else if (sa === "moderate") cons.push("Geologic storage only moderately accessible — transport adds cost");
      else cons.push("Geologic storage is poor/absent here — a major constraint");
    }
    if (dens === "diffuse") {
      if (central) cons.push("Local biomass is diffuse — hauling to a central plant is costly");
      else if (distributed) pros.push("Suits the region's diffuse, distributed biomass");
    } else if (dens === "concentrated" && central) pros.push("Biomass is concentrated — supports a central facility");
    if (nut === "excess") {
      if (key === "bio_oil" || key === "bio_oil_htl" || key === "biochar" || key === "ad_ccs") {
        pros = pros.filter(x => !/nutrient/i.test(x));
        cons.push("Returns nutrients to soils already in surplus here");
      } else if (key === "burial" || key === "injection") {
        pros.push("Removes carbon and nutrients from an over-fertilized landscape");
      }
    }
    // Retrofit-only pathways: mirror engine_core.region_pros_cons (avail = {pp,wte,ad}).
    const av = rec.avail || { pp: true, wte: true, ad: true };
    if (key === "beccs_pp") {
      if (av.pp && rec.anchor_facility) pros.push("Existing mill to retrofit: " + rec.anchor_facility);
      else if (av.pp) pros.push("Existing pulp/bioenergy mill within procurement range to retrofit");
      else cons.push("No existing pulp & paper mill within range to retrofit");
    }
    if (key === "wte_ccs") {
      if (av.wte && rec.anchor_facility) pros.push("Existing WtE plant to retrofit: " + rec.anchor_facility);
      else if (!av.wte) cons.push("No existing waste-to-energy plant within range to retrofit");
    }
    if (key === "ad_ccs") {
      if (av.ad) pros.push("Existing anaerobic-digestion capacity within range to retrofit");
      else cons.push("No existing anaerobic-digestion capacity within range to retrofit");
    }
    return [pros.slice(0, 4), cons.slice(0, 4)];
  }

  // Build a normalized `ranked` list from slim ranked_keys + a PROFILE (US/EU).
  function reconstructRanked(rec, profile) {
    return (rec.ranked_keys || []).map(item => {
      const k = item.k, prof = profile[k] || {};
      const [pros, cons] = regionProsCons(rec, k, profile);
      return { key: k, label: prof.label || k, badge: item.b,
               cdr_efficiency: prof.eff, cost_band: prof.cost, pros: pros, cons: cons };
    });
  }

  // ============================================================
  // SCOPE CONFIGS — only the divergent bits live here.
  // ============================================================
  const SCOPES = {
    uk: {
      label: "United Kingdom",
      hint: "41 UK NUTS-2 (ITL-2) regions. Storage formations (CO2StoP), projects, point sources.",
      scripts: [],  // preloaded in index.html
      view: { center: [54.5, -3.5], zoom: 6, minZoom: 4, maxZoom: 10 },
      fitBounds: true,
      attribution: "Regions: Eurostat GISCO \u00b7 Biomass: JRC ENSPRESO \u00b7 Storage: CO2StoP \u00b7 see Methodology",
      choroRenderer: "svg",
      lowSupplyAware: true,
      statFooter: recs => ({ value: fmt(recs.reduce((s, r) => s + (r.cdr_potential_mtpa || 0), 0)),
        label: "Mt CO\u2082/yr UK CDR potential" }),
      legendNote: {
        feedstock: "Quantile classes across all UK NUTS-2 regions.",
        recommendation: "Best use per Frontier's KPI ranking, computed per NUTS-2 region (storage transport cost + feedstock density). Click a region for rationale.",
      },
      buildGeometry: function () {
        const fc = { type: "FeatureCollection", features: [] };
        (window.GEO_UK_NUTS.features || []).forEach(f => {
          const p = f.properties;
          fc.features.push({ type: "Feature", geometry: f.geometry,
            properties: { _id: p.id, _name: p.name } });
        });
        return fc;
      },
      loadData: function () {
        const profile = window.UK_PATHWAY_PROFILE || {};
        const feedById = {}, recById = {};
        (window.UK_FEEDSTOCKS || []).forEach(r => {
          feedById[r.id] = {
            _id: r.id, _name: r.name, regionKind: "UK NUTS-2 (ITL-2) region",
            ag: r.ag, forestry: r.forestry, msw: r.msw, manure: r.manure, wwtp: r.wwtp,
            biofrac: r.biofrac || 0.55, nutrient_status: r.nutrient_status, dominant_feedstock: r.dominant_feedstock,
          };
        });
        (window.UK_RECOMMENDATIONS || []).forEach(r => {
          recById[r.id] = Object.assign({}, r, { ranked: reconstructRanked(r, profile) });
        });
        return { feedById: feedById, recById: recById };
      },
      feedSection: slimFeedSection,
      transportLookup: id => (window.UK_TRANSPORT || {})[id] || null,
      storageDetailRows: function (rec) {
        const sd = rec.storage_detail || {};
        return [
          { k: "Storage formation", v: sd.in_formation ? "Overlaps " + sd.in_formation + " (theoretical)"
              : (sd.nearest_formation ? `${sd.nearest_formation} (~${sd.nearest_formation_km} km)` : "\u2014") },
          { k: "Storage destination", v: storageDestination(rec, this.transportLookup, sd.nearest_project, sd.nearest_project_km) },
          { k: "Feedstock density", v: `${cap1(rec.feedstock_density)} \u00b7 ${fmt(rec.residue_density_tco2_km2)} tCO\u2082/km\u00b2` },
          { k: "Dominant feedstock", v: labelFeed(rec.dominant_feedstock) },
        ];
      },
      overlays: [
        { id: "facilities", label: "Biogenic point sources", swatch: "sw-fac",
          build: r => facilityCircleLayer(window.UK_FACILITIES || [], r.ov) },
        { id: "wwtps", label: "Large WWTPs (\u2265150k PE)", swatch: "sw-wwtp",
          build: r => wwtpLayer(window.UK_WWTPS || [], r.ov,
            w => `${w.pe ? fmt(w.pe / 1000) + "k PE \u00b7 " : ""}${w.country}`) },
        { id: "projects", label: "CO\u2082 storage projects & salt caverns", swatch: "sw-proj",
          build: r => storageProjectLayer(window.UK_STORAGE_PROJECTS || [], r.ov) },
        { id: "formations", label: "CO\u2082 storage formations (CO2StoP)", swatch: "sw-form",
          build: r => polygonLayer(window.GEO_UK_STORAGE, r.mid, "CO2StoP (JRC)") },
      ],
      methodologyHTML: () => UK_METHODOLOGY,
    },
  };

  // Slim feedstock detail (US/EU): flat values, no per-field sources.
  function slimFeedSection(feed) {
    const rows = [
      ["Agricultural residues", feed.ag, "Mt odt/yr"],
      ["Forestry residues", feed.forestry, "Mt odt/yr"],
      ["MSW (total)", feed.msw, "Mt/yr"],
      ["Animal manure", feed.manure, "Mt odt/yr"],
      ["Human / WWTP", feed.wwtp, "Mt odt/yr"],
    ];
    let html = `<div class="d-sec-title">Feedstock supply</div><table class="feed">`;
    rows.forEach(([lab, v, unit]) => {
      if (v == null || v <= 0) return;
      // Forestry: where a wildfire-fuels-treatment sub-stream exists (US), note how much of the
      // forestry total is fuels residue (thinning/pile/chipping, largely additional) vs commercial.
      let sub = unit;
      if (lab === "Forestry residues" && feed.forestry_fuels > 0) {
        sub = `${unit} · incl. ~${fmt(feed.forestry_fuels)} from wildfire-fuels treatment`;
      }
      html += `<tr><td class="lab">${lab}<div class="unc">${sub}</div></td><td class="val">${fmt(v)}</td></tr>`;
    });
    html += `<tr><td class="lab">MSW biogenic fraction</td><td class="val">${Math.round((feed.biofrac || 0.5) * 100)}%</td></tr></table>`;
    html += `<div class="chips">
      <span class="chip">Dominant: ${labelFeed(feed.dominant_feedstock)}</span>
      <span class="chip">Nutrients: ${cap1(feed.nutrient_status)}</span></div>
      <p class="rationale" style="margin-top:10px">Regional tonnages disaggregate the parent total
      (see Methodology); choropleth values are per-region.</p>`;
    return html;
  }

  // ============================================================
  // Map + persistent panes/renderers (created once)
  // ============================================================
  const map = L.map("map", {
    center: [25, 12], zoom: 2, minZoom: 2, maxZoom: 8,
    worldCopyJump: true, zoomControl: true, attributionControl: false,
  });
  let attribCtl = L.control.attribution({ prefix: false }).addTo(map);
  let attribText = "";

  map.createPane("choroPane"); map.getPane("choroPane").style.zIndex = 410;
  map.createPane("midPane");   map.getPane("midPane").style.zIndex = 450;
  map.createPane("ovPane");    map.getPane("ovPane").style.zIndex = 470;
  const midRenderer = L.svg({ pane: "midPane" });
  const ovRenderer = L.svg({ pane: "ovPane" });

  // ---- Overlay layer builders (shared; used by scope configs) ----
  function facilityCircleLayer(list, rnd) {
    const lg = L.layerGroup();
    list.forEach(f => {
      if (f.lat == null || f.lon == null) return;
      const co2 = (f.est_biogenic_co2_mtpa || {}).value;
      const r = clamp(3, 3 + Math.sqrt(co2 || 0.3) * 3.2, 20);
      const meta = FAC_META[f.type] || { label: f.type, color: "#e0b020" };
      L.circleMarker([f.lat, f.lon], { radius: r, fillColor: meta.color, color: "#0e1419",
        weight: 1, fillOpacity: 0.85, renderer: rnd })
        .bindPopup(facilityPopup(f, meta), { maxWidth: 280 }).addTo(lg);
    });
    return lg;
  }
  function storageSiteLayer(list, rnd) {
    const lg = L.layerGroup();
    list.forEach(s => {
      if (s.lat == null || s.lon == null) return;
      const r = clamp(4, 4 + Math.sqrt(s.capacity_mtpa || 0.5) * 4, 18);
      const op = s.status === "operational" ? 0.9 : s.status === "construction" ? 0.6 : 0.35;
      L.circleMarker([s.lat, s.lon], { radius: r, fillColor: "#46b3ff", color: "#eafffb",
        weight: 1.2, fillOpacity: op, renderer: rnd })
        .bindPopup(sitePopup(s), { maxWidth: 280 }).addTo(lg);
    });
    return lg;
  }
  function storageProjectLayer(list, rnd) {
    const lg = L.layerGroup();
    list.forEach(p => {
      if (p.lat == null || p.lon == null) return;
      const cavern = p.kind === "salt_cavern" || p.storage_type === "salt_cavern";
      const r = p.capacity_mtpa ? clamp(6, 6 + Math.sqrt(p.capacity_mtpa) * 3, 16) : 7;
      const op = p.status === "operational" ? 0.95 : p.status === "construction" ? 0.7 : 0.42;
      // Salt caverns (prospective bio-oil / biomass injection sites) get a distinct amber, hollow
      // marker so they read as "developable, not a CO₂ project" against the blue CO₂ hubs.
      L.circleMarker([p.lat, p.lon], cavern
        ? { radius: r, fillColor: "#e0843b", color: "#ffd9ad", weight: 1.4, fillOpacity: 0.4,
            dashArray: "3 2", renderer: rnd }
        : { radius: r, fillColor: "#46b3ff", color: "#eafffb", weight: 1.2, fillOpacity: op, renderer: rnd })
        .bindPopup(projectPopup(p, cavern), { maxWidth: 300 }).addTo(lg);
    });
    return lg;
  }
  function storageBasinCircleLayer(list, rnd) {
    const lg = L.layerGroup();
    list.forEach(s => {
      if (s.lat == null || s.lon == null) return;
      const r = clamp(8, Math.sqrt(s.capacity_gt || 1) * 1.5, 40);
      const confOp = s.confidence === "high" ? 0.32 : s.confidence === "medium" ? 0.2 : 0.1;
      const confLine = s.confidence === "high" ? 0.9 : s.confidence === "medium" ? 0.6 : 0.3;
      L.circleMarker([s.lat, s.lon], { radius: r, fillColor: "#7aa6ff", color: "#6f93c9",
        weight: 1, fillOpacity: confOp, opacity: confLine, renderer: rnd })
        .bindPopup(basinPopup(s), { maxWidth: 280 }).addTo(lg);
    });
    return lg;
  }
  function wwtpLayer(list, rnd, subFn) {
    const lg = L.layerGroup();
    list.forEach(w => {
      if (w.lat == null || w.lon == null) return;
      L.circleMarker([w.lat, w.lon], { radius: 2.5, fillColor: "#5bb0c7", color: "#0e1419",
        weight: 0.5, fillOpacity: 0.8, renderer: rnd })
        .bindPopup(`<b>${w.name}</b><br>Large WWTP · ${subFn(w)}
          <div class="pop-src">Source: ${w.source || "—"}</div>`, { maxWidth: 260 }).addTo(lg);
    });
    return lg;
  }
  function wellLayer(list, rnd, color) {
    const lg = L.layerGroup();
    list.forEach(w => {
      if (w.lat == null || w.lon == null) return;
      const op = w.status === "operational" ? 0.95 : w.status === "issued" ? 0.85
        : w.status === "draft" ? 0.55 : 0.35;
      const r = w.co2_mtpa ? clamp(5, 5 + Math.sqrt(w.co2_mtpa) * 4, 16) : 6;
      L.circleMarker([w.lat, w.lon], { radius: r, fillColor: color, color: "#eafffb",
        weight: 1.2, fillOpacity: op, renderer: rnd })
        .bindPopup(wellPopup(w), { maxWidth: 280 }).addTo(lg);
    });
    return lg;
  }
  function polygonLayer(fc, rnd, sourceLabel) {  // non-interactive storage polygons (click-through)
    return L.geoJSON(fc, { renderer: rnd, interactive: false,
      style: { fillColor: "#7aa6ff", color: "#6f93c9", weight: 0.9, fillOpacity: 0.16, opacity: 0.5 } });
  }

  function facilityPopup(f, meta) {
    const co2 = f.est_biogenic_co2_mtpa || {};
    return `<b>${f.name}</b><br>${meta.label}${f.capacity_note ? " · " + f.capacity_note : ""}<br>
      Biogenic CO₂: <b>${co2.value != null ? fmt(co2.value) + " Mtpa" : "n/a"}</b> ${rangeTxt(co2)}<br>
      Retrofit potential: <b>${cap1(f.retrofit_score)}</b>${f.country || f.state ? " · " + (f.state || f.country) : ""}
      ${f.operator ? "<br>Operator: " + f.operator : ""}
      ${f.notes ? `<div class="pop-src">${f.notes}</div>` : ""}
      <div class="pop-src">Source: ${f.source || "—"}</div>`;
  }
  function sitePopup(s) {
    return `<b>${s.name}</b><br>CO₂ storage project · ${cap1(s.status)}<br>
      Type: ${STORAGE_TYPE[s.storage_type] || s.storage_type}<br>
      Capacity: <b>${s.capacity_mtpa != null ? fmt(s.capacity_mtpa) + " Mtpa" : "n/a"}</b>
      <div class="pop-src">Source: ${s.source || "—"}</div>`;
  }
  function projectPopup(p, cavern) {
    if (cavern) {
      return `<b>${p.name}</b><br>Salt-cavern bio-oil / biomass injection site · <b>prospective</b><br>
        <div class="caveat" style="margin:6px 0">⚠ Not yet developed or permitted for bio-oil/biomass
        storage in the UK — developable potential, not shovel-ready.</div>
        ${p.notes ? p.notes + "<br>" : ""}
        <div class="pop-src">Source: ${p.source || "—"}</div>`;
    }
    return `<b>${p.name}</b><br>CO₂ storage project · ${cap1(p.status)}<br>
      ${p.storage_type ? "Type: " + (STORAGE_TYPE[p.storage_type] || p.storage_type) + "<br>" : ""}
      ${p.capacity_mtpa ? "Capacity: <b>" + fmt(p.capacity_mtpa) + " Mtpa</b><br>" : ""}${p.country || ""}
      <div class="pop-src">Source: ${p.source || "—"}</div>`;
  }
  function basinPopup(s) {
    return `<b>${s.name}</b><br>Basin storage potential<br>
      Type: ${STORAGE_TYPE[s.storage_type] || s.storage_type}<br>
      Capacity: <b>${s.capacity_gt != null ? fmt(s.capacity_gt) + " Gt" : "n/a"}</b> · confidence: <b>${cap1(s.confidence)}</b>
      ${s.notes ? `<div class="pop-src">${s.notes}</div>` : ""}
      <div class="pop-src">Source: ${s.source || "—"}</div>`;
  }
  function wellPopup(w) {
    const cls = w.well_class === "V" ? "Class V (biomass / bio-oil injection)"
      : w.well_class === "VI/RR" ? "Geologic sequestration (Subpart RR)"
      : w.well_class === "VI" ? "Class VI (CO₂ storage)"
      : "CO₂ storage project / hub";  // Canada: curated CCS projects (no US well classes)
    return `<b>${w.name}</b><br>${cls} · ${cap1(w.status)}<br>
      ${w.operator ? "Operator: " + w.operator + "<br>" : ""}
      ${w.co2_mtpa ? "CO₂: <b>" + fmt(w.co2_mtpa) + " Mtpa</b><br>" : ""}${w.state || w.prov || ""}
      <div class="pop-src">Source: ${w.source || "—"}</div>`;
  }

  // ============================================================
  // Active-scope state + shared rendering
  // ============================================================
  const state = { scope: "uk", mode: "feedstock", feedstock: "ag", breaks: [], openRegion: null, showRoute: false };
  let combined = null, feedById = {}, recById = {};
  let geoLayer = null, choroRenderer = null;
  let activeOverlays = [];  // [{id, layer, checkbox}]
  const routeGroup = L.featureGroup();   // multimodal transport route (featureGroup → has getBounds)
  const ROUTE_MODE = {                 // colour + label per transport mode
    truck: { color: "#e0843b", label: "Truck" },
    rail: { color: "#8a6fd4", label: "Rail" },
    ship: { color: "#46b3ff", label: "Ship (coastal)" },
    barge: { color: "#3fb6a8", label: "Barge (river)" },
  };

  const dom = {
    hovertip: document.getElementById("hovertip"),
    detail: document.getElementById("detail"),
    detailBody: document.getElementById("detail-body"),
    legend: document.getElementById("legend"),
    legendTitle: document.getElementById("legend-title"),
    overlayList: document.getElementById("overlay-list"),
    feedControls: document.getElementById("feedstock-controls"),
    feedSelect: document.getElementById("feedstock-select"),
    feedHint: document.getElementById("feedstock-hint"),
    scopeHint: document.getElementById("scope-hint"),
    statCdr: document.getElementById("stat-cdr"),
    statLabel: document.getElementById("stat-label"),
  };

  function styleFeature(feature) {
    const id = feature.properties._id;
    let fill = NODATA, opacity = 0.38;
    if (state.mode === "feedstock") {
      const c = colorForValue(feedValue(feedById[id], state.feedstock), state.breaks);
      if (c) { fill = c; opacity = 0.92; }
    } else {
      const rec = recById[id];
      if (rec && !rec.low_supply && !rec.no_option && PATH_META[rec.recommended]) { fill = PATH_META[rec.recommended].color; opacity = 0.9; }
      else if (rec && (rec.low_supply || rec.no_option)) { fill = NODATA; opacity = 0.5; }
    }
    return { fillColor: fill, fillOpacity: opacity, color: "#0e1419", weight: 0.5 };
  }
  function recomputeBreaks() {
    state.breaks = quantileBreaks(
      combined.features.map(f => feedValue(feedById[f.properties._id], state.feedstock)), GREENS.length);
  }
  function redrawChoropleth() {
    if (state.mode === "feedstock") recomputeBreaks();
    if (geoLayer) geoLayer.setStyle(styleFeature);
    renderLegend();
  }

  let hoveredLayer = null;
  function highlight(layer) {
    if (hoveredLayer && hoveredLayer !== layer && geoLayer) geoLayer.resetStyle(hoveredLayer);
    hoveredLayer = layer;
    layer.setStyle({ weight: 1.8, color: "#eafffb" });
  }
  function unhighlight(layer) {
    if (geoLayer) geoLayer.resetStyle(layer);
    if (hoveredLayer === layer) hoveredLayer = null;
  }
  function showHoverTip(e, feature) {
    const id = feature.properties._id, name = feature.properties._name;
    let sub;
    if (state.mode === "feedstock") {
      const v = feedValue(feedById[id], state.feedstock);
      sub = v == null ? "no data" : `<span class="ht-val">${fmt(v)} Mt/yr</span>`;
    } else {
      const rec = recById[id];
      if (!rec) sub = "no data";
      else if (rec.no_option) sub = `<span class="ht-val lowsup">No viable BiCRS pathway</span>`;
      else sub = `<span class="ht-val">${PATH_META[rec.recommended].label}</span>`
        + (rec.low_supply ? ' <span class="lowsup">· low supply</span>' : "");
    }
    dom.hovertip.innerHTML = `<div class="ht-name">${name}</div>${sub}`;
    dom.hovertip.classList.remove("hidden");
    moveHoverTip(e);
  }
  function moveHoverTip(e) {
    dom.hovertip.style.left = e.originalEvent.clientX + "px";
    dom.hovertip.style.top = e.originalEvent.clientY + "px";
  }
  function hideHoverTip() { dom.hovertip.classList.add("hidden"); }

  // ---- Detail panel (shared) ----
  // ---- Multimodal transport route (to_do item 4) ----
  function transportFor(sc, id) {
    return (sc.transportLookup && id) ? sc.transportLookup(id) : null;
  }

  function redrawRoute() {
    routeGroup.clearLayers();
    const sc = SCOPES[state.scope];
    if (!state.showRoute || !state.openRegion) { return; }
    const t = transportFor(sc, state.openRegion.id);
    if (!t || !t.legs || !t.legs.length) return;
    // Draw the route to the recommended pathway's ACTUAL store: a capture pathway ships CO₂ to the
    // CO₂-eligible project (co2_legs); an injection/bio-oil pathway hauls to the salt-cavern /
    // injection site (inj_legs). Otherwise the general route.
    const rec = recById[state.openRegion.id];
    const pay = rec && PAYLOAD_OF[rec.recommended];
    let legs = t.legs;
    if (pay === "co2" && t.co2_legs && t.co2_legs.length) legs = t.co2_legs;
    else if ((pay === "slurry" || pay === "bio_oil" || pay === "bio_oil_htl") && t.inj_legs && t.inj_legs.length) legs = t.inj_legs;
    legs.forEach(leg => {
      const m = ROUTE_MODE[leg.mode] || { color: "#aaa", label: leg.mode };
      // ship/barge legs follow real water geometry (leg.path); truck/rail are straight from→to
      const line = (leg.path && leg.path.length > 1) ? leg.path : [leg.from, leg.to];
      // dark casing underneath so the coloured line is legible over any choropleth colour
      L.polyline(line, { color: "#0e1419", weight: 7, opacity: 0.55,
        renderer: ovRenderer }).addTo(routeGroup);
      L.polyline(line, {
        color: m.color, weight: 4, opacity: 0.95, renderer: ovRenderer,
        dashArray: (leg.mode === "ship" || leg.mode === "barge") ? "8 5" : null,
      }).bindTooltip(`${m.label}: ${leg.km} km`, { sticky: true }).addTo(routeGroup);
      if (leg.to_name) {   // transfer / destination node marker
        L.circleMarker(leg.to, { radius: 4, fillColor: m.color, color: "#0e1419",
          weight: 1, fillOpacity: 1, renderer: ovRenderer })
          .bindTooltip(leg.to_name, { direction: "top" }).addTo(routeGroup);
      }
    });
    if (!map.hasLayer(routeGroup)) routeGroup.addTo(map);
  }

  function transportSummaryHTML(sc, id) {
    const t = transportFor(sc, id);
    if (!t) return "";
    const modes = (t.modes || []).map(m => (ROUTE_MODE[m] || { label: m }).label).join(" → ");
    const bp = t.by_payload || {};
    const row = (lbl, v) => `<div><div class="k">${lbl}</div><div class="v">${v == null ? "—" : "$" + fmt(v) + "/tCO₂"}</div></div>`;
    return `<div class="chart-card">
      <div class="chart-title">Transport to storage <span class="hint" style="font-weight:400">(screening, v1)</span></div>
      <div class="chart-sub">Least-cost route to nearest operating well: <b>${t.dest_well || "—"}</b> · ${modes || "—"} · ${fmt(t.total_km)} km. Delivered cost by what's moved (carbon-density-weighted):</div>
      <div class="d-metrics">
        ${row("Captured CO₂ (BECCS/WtE/AD)", bp.co2)}
        ${row("Bio-oil (densified)", bp.bio_oil)}
        ${row("Wet biomass slurry (injection)", bp.slurry)}
      </div>
      <div class="chart-sub" style="margin-top:6px">Toggle <b>CO₂ transport route</b> in Map layers to draw the path. Great-circle screening, not yet network-routed.</div>
    </div>`;
  }

  function openDetail(id, name) {
    state.openRegion = { id: id, name: name };
    const rec = recById[id], feed = feedById[id];
    const sc = SCOPES[state.scope];
    if (!rec && !feed) {
      dom.detailBody.innerHTML = `<div class="d-region">Region</div><div class="d-name">${name}</div>
        <p class="rationale">No BiCRS data compiled for this region in the ${sc.label} scope.</p>`;
      dom.detail.classList.remove("hidden");
      return;
    }
    const regionKind = (feed && feed.regionKind) || "Region";
    let html = `<div class="d-region">${regionKind}</div><div class="d-name">${name}</div>`;
    if (state.mode === "feedstock") {
      if (feed) html += feedstockBarChart(feed) + sc.feedSection(feed);
      else if (rec) html += recCard(rec, sc);
    } else {
      if (rec) html += recCard(rec, sc) + rankedList(rec);
      else if (feed) html += sc.feedSection(feed);
    }
    html += transportSummaryHTML(sc, id);
    dom.detailBody.innerHTML = html;
    dom.detail.classList.remove("hidden");
    redrawRoute();
  }

  function feedstockBarChart(feed) {
    const items = [
      ["Agricultural residues", (feed.ag || 0) * 1.47, "#6fbf73"],
      ["Forestry residues", (feed.forestry || 0) * 1.47, "#2f8f57"],
      ["MSW (biogenic)", (feed.msw || 0) * (feed.biofrac || 0.5) * 1.0, "#c0556b"],
      ["Animal manure", (feed.manure || 0) * 1.47, "#b07d3a"],
      ["Human / WWTP", (feed.wwtp || 0) * 1.47, "#9b59d0"],
    ].filter(x => x[1] > 0).sort((a, b) => b[1] - a[1]);
    if (!items.length) return `<p class="rationale">Negligible recoverable biomass.</p>`;
    const max = items[0][1], total = items.reduce((s, x) => s + x[1], 0);
    let html = `<div class="chart-card">
      <div class="chart-title">Biogenic CO₂ potential by feedstock</div>
      <div class="chart-sub">Carbon embodied in each waste stream · Mt CO₂/yr · actual CDR depends on pathway efficiency</div>`;
    items.forEach(([label, val, color]) => {
      const pct = Math.max(2, (val / max) * 100);
      html += `<div class="bar-row"><div class="bar-label">${label}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${color}"></div></div>
        <div class="bar-val">${fmt(val)}</div></div>`;
    });
    html += `<div class="chart-total">Total embodied biogenic CO₂: <b>${fmt(total)} Mt CO₂/yr</b></div></div>`;
    return html;
  }

  function recCard(rec, sc) {
    if (rec.no_option) {   // no good BiCRS pathway — distinct muted card, no KPI grid
      let h = `<div class="rec-card">
        <div class="rec-top"><span class="rec-pill" style="background:#3a4350">NO VIABLE PATHWAY</span>
          <h3>No good BiCRS option here</h3></div>
        <p class="rationale">${rec.rationale || ""}</p>`;
      (rec.caveats || []).forEach(c => { h += `<div class="caveat">${c}</div>`; });
      h += `</div>`;
      if (sc.storageDetailRows) {
        const rows = sc.storageDetailRows(rec);
        h += `<div class="d-metrics">` + rows.map(r =>
          `<div><div class="k">${r.k}</div><div class="v">${r.v}</div></div>`).join("") + `</div>`;
      }
      return h;
    }
    const meta = PATH_META[rec.recommended] || { label: rec.recommended_label, color: "#888" };
    const eff = rec.cdr_efficiency != null ? Math.round(rec.cdr_efficiency * 100) + "%" : "—";
    const cdr = rec.cdr_potential_mtpa != null ? fmt(rec.cdr_potential_mtpa) + " Mtpa" : "—";
    // routed transport distance (from the transport model) + delivered storage-transport cost,
    // shown only for storage-dependent pathways (burial/biochar are stored locally — no transport).
    const usesTransport = !!PAYLOAD_OF[rec.recommended];
    const t = (sc.transportLookup && rec.id) ? sc.transportLookup(rec.id) : null;
    // routed km to the destination the recommended pathway uses (CO₂-eligible well for capture
    // pathways — item 7); fall back to the general route, then great-circle.
    const distKm = (rec.transport_dest_km != null) ? rec.transport_dest_km
      : (t && t.total_km != null) ? t.total_km : rec.nearest_storage_km;
    const storage = cap1(rec.storage_access) + (usesTransport && distKm != null ? " · ~" + fmt(distKm) + " km" : "");
    const storageCost = rec.transport_usd_per_tco2 != null ? "$" + fmt(rec.transport_usd_per_tco2) + "/tCO₂"
      : (usesTransport ? "—" : "none (stored locally)");
    let html = `<div class="rec-card">
      <div class="rec-top"><span class="rec-pill" style="background:${meta.color}">RECOMMENDED</span>
        <h3>${rec.recommended_label}</h3></div>`;
    if (rec.low_supply) html += `<div class="caveat lowsup">Negligible recoverable biomass — recommendation indicative only.</div>`;
    html += `<div class="rec-meta">
        <div><div class="k">CDR efficiency</div><div class="v">${eff}</div></div>
        <div><div class="k">CDR potential</div><div class="v">${cdr}</div></div>
        <div><div class="k">Pathway cost</div><div class="v" style="font-size:12px">${rec.cost_band || "—"}</div></div>
        <div><div class="k">Storage transport</div><div class="v" style="font-size:12px">${storageCost}</div></div>
        <div><div class="k">Storage access</div><div class="v" style="font-size:12px">${storage}</div></div>
        <div><div class="k">Retrofit anchor</div><div class="v" style="font-size:11px">${rec.anchor_facility || "none mapped"}</div></div>
      </div>`;
    // Delivered (all-in) cost = pathway conversion + transport-to-well. Only meaningful in a
    // transport-aware scope (US/CA/EU); the global scope has no routed transport, so it is omitted
    // there (the conversion band is already shown above). Storage-independent pathways
    // (burial/biochar) have no transport leg, so delivered == conversion.
    const dc = sc.transportLookup ? deliveredCost(rec.cost_band, rec.transport_usd_per_tco2) : null;
    if (dc) {
      const breakdown = rec.transport_usd_per_tco2 != null
        ? `conversion ${dc.conv} + transport ~$${fmt(rec.transport_usd_per_tco2)}`
        : (usesTransport
            ? `conversion ${dc.conv}; transport to storage not separately modelled here`
            : `conversion ${dc.conv}, no transport to a well (stored locally)`);
      html += `<div class="delivered-cost">Delivered cost ≈ <b>${dc.range}/tCO₂</b>
        <span class="dc-breakdown">(${breakdown})</span></div>`;
    }
    html += `<p class="rationale">${rec.rationale || ""}</p>
      <div class="runner">Runner-up: <b>${rec.runner_up_label}</b></div>`;
    (rec.caveats || []).forEach(c => { html += `<div class="caveat">${c}</div>`; });
    (rec.flags || []).forEach(f => { html += `<div class="flag">${f}</div>`; });
    html += `</div>`;
    if (sc.storageDetailRows) {
      const rows = sc.storageDetailRows(rec);
      html += `<div class="d-metrics">` + rows.map(r =>
        `<div><div class="k">${r.k}</div><div class="v">${r.v}</div></div>`).join("") + `</div>`;
    }
    return html;
  }

  function rankedList(rec) {
    if (!rec.ranked || !rec.ranked.length) return "";
    const badgeClass = b => "rk-" + b.toLowerCase().replace(/[^a-z]+/g, "");
    let html = `<div class="d-sec-title">CDR options ranked — best to worst here</div>`;
    rec.ranked.forEach((p, i) => {
      const color = (PATH_META[p.key] || {}).color || "#888";
      const pros = (p.pros || []).map(x => `<li>${x}</li>`).join("");
      const cons = (p.cons || []).map(x => `<li>${x}</li>`).join("");
      // delivered (all-in) cost per ranked pathway, when a transport cost is known for its payload
      const ptc = (rec.transport_by_payload && PAYLOAD_OF[p.key]) ? rec.transport_by_payload[PAYLOAD_OF[p.key]] : null;
      const pdc = (ptc != null) ? deliveredCost(p.cost_band, ptc) : null;
      const deliveredStr = pdc ? ` · delivered ≈ <b>${pdc.range}/tCO₂</b>` : "";
      html += `<div class="rank-item">
        <div class="rank-head">
          <span class="rank-num" style="background:${color}">${i + 1}</span>
          <span class="rank-name">${p.label}</span>
          <span class="rank-badge ${badgeClass(p.badge)}">${p.badge}</span>
        </div>
        <div class="rank-meta">${Math.round((p.cdr_efficiency || 0) * 100)}% CDR efficiency · ${p.cost_band || ""}${deliveredStr}</div>
        <div class="rank-pc"><ul class="pc-pros">${pros}</ul><ul class="pc-cons">${cons}</ul></div>
      </div>`;
    });
    return html;
  }

  function refreshDetail() {
    if (state.openRegion && !dom.detail.classList.contains("hidden")) {
      openDetail(state.openRegion.id, state.openRegion.name);
    }
  }
  function closeDetail() { dom.detail.classList.add("hidden"); state.openRegion = null; redrawRoute(); }
  document.getElementById("detail-close").onclick = closeDetail;

  // ---- Legend (shared; scope supplies notes + low-supply awareness) ----
  function renderLegend() {
    const sc = SCOPES[state.scope];
    if (state.mode === "feedstock") {
      dom.legendTitle.textContent = FEEDSTOCK_LABEL[state.feedstock] + " (Mt/yr)";
      const b = state.breaks, ranges = [];
      let prev = 0;
      for (let i = 0; i < GREENS.length; i++) { const hi = i < b.length ? b[i] : null; ranges.push([prev, hi]); prev = hi; }
      let html = "";
      ranges.forEach((rg, i) => {
        const lab = rg[1] == null ? `≥ ${fmt(rg[0])}` : `${fmt(rg[0])} – ${fmt(rg[1])}`;
        html += `<div class="legend-row"><span class="box" style="background:${GREENS[i]}"></span>${lab}</div>`;
      });
      html += `<div class="legend-row"><span class="box" style="background:${NODATA}"></span>No / negligible data</div>`;
      html += `<div class="legend-note">${sc.legendNote.feedstock}</div>`;
      dom.legend.innerHTML = html;
    } else {
      dom.legendTitle.textContent = "Recommended pathway";
      const counts = {};
      let nNone = 0;
      Object.values(recById).forEach(r => {
        if (r.no_option) { nNone++; return; }
        if (sc.lowSupplyAware && r.low_supply) return;
        counts[r.recommended] = (counts[r.recommended] || 0) + 1;
      });
      let html = "";
      Object.keys(PATH_META).forEach(k => {
        if (!counts[k]) return;
        html += `<div class="legend-row"><span class="box" style="background:${PATH_META[k].color}"></span>
          ${PATH_META[k].label} <span style="color:var(--ink-3);margin-left:auto;font-family:var(--mono);font-size:10px">${counts[k]}</span></div>`;
      });
      const greyLabel = nNone ? "No viable pathway" + (sc.lowSupplyAware ? " / low supply" : "") : (sc.lowSupplyAware ? "Low / negligible supply" : "No data");
      html += `<div class="legend-row"><span class="box" style="background:${NODATA}"></span>${greyLabel}${nNone ? ` <span style="color:var(--ink-3);margin-left:auto;font-family:var(--mono);font-size:10px">${nNone}</span>` : ""}</div>`;
      html += `<div class="legend-note">${sc.legendNote.recommendation}</div>`;
      dom.legend.innerHTML = html;
    }
  }

  // ---- Overlay checkbox list (rebuilt per scope) ----
  function buildOverlays(sc) {
    activeOverlays.forEach(o => { if (map.hasLayer(o.layer)) map.removeLayer(o.layer); });
    activeOverlays = [];
    dom.overlayList.innerHTML = "";
    sc.overlays.forEach(def => {
      const layer = def.build({ ov: ovRenderer, mid: midRenderer });
      const lbl = document.createElement("label");
      lbl.className = "chk";
      lbl.innerHTML = `<input type="checkbox" data-ov="${def.id}" /> <span class="sw ${def.swatch}"></span> ${def.label}`;
      const cb = lbl.querySelector("input");
      cb.onchange = e => { e.target.checked ? layer.addTo(map) : map.removeLayer(layer); };
      dom.overlayList.appendChild(lbl);
      activeOverlays.push({ id: def.id, layer: layer, checkbox: cb });
    });
    // Region-dependent transport-route toggle (only where a transport model exists for the scope).
    routeGroup.clearLayers();
    state.showRoute = false;
    if (sc.transportLookup) {
      const lbl = document.createElement("label");
      lbl.className = "chk";
      lbl.innerHTML = `<input type="checkbox" data-ov="route" /> ` +
        `<span class="sw" style="background:linear-gradient(90deg,#e0843b 0 25%,#8a6fd4 25% 50%,#46b3ff 50% 75%,#3fb6a8 75%)"></span> ` +
        `CO₂ transport route <span class="hint" style="font-weight:400">(selected region)</span>`;
      lbl.querySelector("input").onchange = e => {
        state.showRoute = e.target.checked;
        redrawRoute();
        if (state.showRoute && routeGroup.getLayers().length) {
          try { map.fitBounds(routeGroup.getBounds(), { padding: [40, 40], maxZoom: 7 }); } catch (_) {}
        }
      };
      dom.overlayList.appendChild(lbl);
    }
  }

  // ============================================================
  // Scope switching (with lazy script loading)
  // ============================================================
  const loaded = { uk: true };  // the single UK scope is preloaded in index.html
  function loadScope(id) {
    return new Promise((resolve, reject) => {
      if (loaded[id]) return resolve();
      const queue = SCOPES[id].scripts.slice();
      (function next() {
        if (!queue.length) { loaded[id] = true; return resolve(); }
        const s = document.createElement("script");
        s.src = queue.shift();
        s.onload = next;
        s.onerror = () => reject(new Error("Failed to load " + s.src));
        document.body.appendChild(s);
      })();
    });
  }

  function setAttribution(text) {
    if (attribText) attribCtl.removeAttribution(attribText);
    attribText = text;
    attribCtl.addAttribution(text);
  }

  let switching = false;
  function setScope(id, opts) {
    opts = opts || {};
    if (switching) return Promise.resolve();
    const sc = SCOPES[id];
    if (!sc) return Promise.resolve();
    switching = true;
    document.querySelectorAll("#scope-seg .seg-btn").forEach(b =>
      b.classList.toggle("active", b.dataset.scope === id));
    dom.scopeHint.textContent = sc.hint;

    return loadScope(id).then(() => {
      state.scope = id;
      closeDetail();
      hideHoverTip();

      // teardown — remove the layer AND its renderer so no stale renderer element
      // lingers in choroPane (which would break the next scope's hit-detection).
      if (geoLayer) { map.removeLayer(geoLayer); geoLayer = null; }
      if (choroRenderer) { map.removeLayer(choroRenderer); choroRenderer = null; }
      hoveredLayer = null;

      // data + geometry
      combined = sc.buildGeometry();
      const data = sc.loadData();
      feedById = data.feedById; recById = data.recById;

      // choropleth with the scope's renderer
      choroRenderer = sc.choroRenderer === "canvas"
        ? L.canvas({ pane: "choroPane" }) : L.svg({ pane: "choroPane" });
      geoLayer = L.geoJSON(combined, {
        style: styleFeature, renderer: choroRenderer,
        onEachFeature: function (feature, layer) {
          layer.on({
            mouseover: e => { highlight(e.target); showHoverTip(e, feature); },
            mousemove: moveHoverTip,
            mouseout: e => { unhighlight(e.target); hideHoverTip(); },
            click: () => openDetail(feature.properties._id, feature.properties._name),
          });
        },
      }).addTo(map);

      buildOverlays(sc);
      setAttribution(sc.attribution);
      document.getElementById("method-body").innerHTML = sc.methodologyHTML();
      const stat = sc.statFooter(Object.values(recById));
      dom.statCdr.textContent = stat.value;
      dom.statLabel.textContent = stat.label;

      map.setMinZoom(sc.view.minZoom); map.setMaxZoom(sc.view.maxZoom);
      if (!opts.keepView) {
        if (sc.fitBounds) { try { map.fitBounds(geoLayer.getBounds(), { padding: [10, 10] }); } catch (e) { map.setView(sc.view.center, sc.view.zoom); } }
        else map.setView(sc.view.center, sc.view.zoom);
      }
      redrawChoropleth();
      switching = false;
    }).catch(err => {
      switching = false;
      dom.overlayList.innerHTML = `<p class="hint" style="color:#e6a0a0">Could not load ${sc.label} data (${err.message}). If viewing offline, ensure the data files are present.</p>`;
    });
  }

  // ============================================================
  // Controls wiring
  // ============================================================
  document.querySelectorAll("#scope-seg .seg-btn").forEach(btn => {
    btn.onclick = () => { if (btn.dataset.scope !== state.scope) setScope(btn.dataset.scope); };
  });
  document.querySelectorAll("#mode-seg .seg-btn").forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll("#mode-seg .seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.mode = btn.dataset.mode;
      dom.feedControls.style.display = state.mode === "feedstock" ? "" : "none";
      redrawChoropleth();
      refreshDetail();
    };
  });
  dom.feedSelect.onchange = () => {
    state.feedstock = dom.feedSelect.value;
    dom.feedHint.textContent = FEEDSTOCK_HINTS[state.feedstock] || "";
    redrawChoropleth();
    refreshDetail();
  };

  const methodModal = document.getElementById("method-modal");
  document.getElementById("open-method").onclick = () => methodModal.classList.remove("hidden");
  document.getElementById("method-close").onclick = () => methodModal.classList.add("hidden");
  methodModal.onclick = e => { if (e.target === methodModal) methodModal.classList.add("hidden"); };

  // ---- Deep-link hash: #mode=recommendation&feed=ag&ov=facilities,projects&region=EU-UKC1 ----
  function applyHash() {
    const h = (location.hash || "").replace(/^#/, "");
    const p = {};
    h.split("&").forEach(kv => { const [k, v] = kv.split("="); if (k) p[k] = decodeURIComponent(v || ""); });
    const scope = "uk";   // single-scope build (any legacy scope= param is ignored)
    setScope(scope).then(() => {
      if (p.mode === "recommendation" || p.mode === "feedstock") {
        const btn = document.querySelector(`#mode-seg .seg-btn[data-mode="${p.mode}"]`);
        if (btn) btn.click();
      }
      if (p.feed && FEEDSTOCK_LABEL[p.feed]) { dom.feedSelect.value = p.feed; dom.feedSelect.onchange(); }
      if (p.ov) p.ov.split(",").forEach(oid => {
        const o = activeOverlays.find(x => x.id === oid);
        if (o) { o.checkbox.checked = true; o.layer.addTo(map); }
      });
      if (p.region) {
        const r = feedById[p.region] || recById[p.region];
        if (r) openDetail(p.region, (feedById[p.region] && feedById[p.region]._name) || r.name || p.region);
      }
    });
  }

  // ============================================================
  // Methodology texts (per scope)
  // ============================================================
  const UK_METHODOLOGY = `
    <h2>Methodology &amp; sources \u2014 UK BiCRS Atlas</h2>
    <p>This map is the <b>United Kingdom subset of Frontier's BiCRS Atlas</b>: 41 NUTS-2 / ITL-2 regions,
    each with recoverable biomass supply, CO\u2082 storage access, and a transparent best-use-of-biomass
    recommendation encoding Frontier's KPI ranking \u2014 <b>CDR efficiency \u203a emissions-avoiding
    co-product \u203a other co-benefits</b> \u2014 modulated by feedstock moisture/density, storage
    proximity, nutrient status, and retrofit availability.</p>
    <h3>Regional feedstocks</h3>
    <p>"JRC ENSPRESO NUTS-2 distribution, scaled to the UK country total." Within-UK distribution from the
    JRC ENSPRESO biomass database (ag residues, forest + secondary-wood residues, manure/biogas); MSW &amp;
    biosolids allocated by NUTS-2 population (Eurostat, pre-Brexit UK series). Regions are scaled so they
    sum to the UK totals in the global Atlas (FAOSTAT / World Bank <i>What a Waste</i> / IEA-FAO basis).
    Purpose-grown energy/biofuel crops are excluded by design.</p>
    <h3>CO\u2082 storage</h3>
    <p>Storage formations are <b>actual polygons</b> from the EU CO2StoP database (JRC) \u2014 the UK's
    assessed saline-aquifer and hydrocarbon-field storage units, overwhelmingly offshore (Southern &amp;
    Central North Sea, East Irish Sea). Storage projects/hubs: <b>Northern Endurance Partnership</b>
    (East Coast Cluster, in construction), <b>Liverpool Bay / HyNet</b> (in construction), <b>Acorn</b>
    and <b>Viking</b> (planned) \u2014 plus the non-UK destinations some regions route to (Porthos,
    Sleipner). These offshore projects are engineered and permitted for <b>gaseous / dense-phase
    CO\u2082 only</b>, so the CO\u2082-capture pathways (BECCS, WtE+CCS, AD+CCS) route to them.</p>
    <h3>Bio-oil / biomass injection storage (salt caverns \u2014 prospective)</h3>
    <p>Biomass-slurry injection and bio-oil sequestration need a store that takes <b>liquids/solids,
    not gaseous CO\u2082</b> \u2014 the UK's realistic option is <b>salt caverns</b> (Cheshire/Holford,
    Teesside, East Yorkshire/Aldbrough &amp; Atwick, Lancashire/Preesall, Dorset/Portland, N. Ireland/
    Islandmagee), shown as amber markers. Bio-oil/biomass storage in salt caverns is a recognised
    method (Isometric protocol), but <b>no UK site is yet developed or permitted for it</b>, so these
    are flagged <b>prospective</b>: the injection &amp; bio-oil pathways route to the nearest salt
    cavern and carry a caution that this storage is developable potential, not shovel-ready.</p>
    <h3>Point sources &amp; WWTPs</h3>
    <p>Curated UK biogenic-CO\u2082 facilities (biomass power, WtE, biogas/AD) with biogenic CO\u2082
    estimated from capacity (UK ETS zero-rates sustainable biomass \u2014 the weakest layer); large
    WWTPs (\u2265150,000 PE) from the EEA/EMODnet UWWTD.</p>
    <h3>Engine</h3>
    <p>Same engine as the Atlas's Europe scope. Storage access is <b>cost-based</b> where the multimodal
    transport model (truck / rail / ship) reaches an operating or in-construction storage project
    (good \u2264 $66 / moderate \u2264 $100 / poor &gt; $100 per tCO\u2082 delivered), else great-circle
    distance (good &lt;150 km / moderate &lt;400 km). The detail panel shows a <b>delivered cost</b>
    \u2248 pathway conversion band + transport-to-storage. Retrofit-gated pathways (BECCS pulp &amp;
    paper, WtE+CCS, AD+CCS) are recommendable only within feedstock-procurement range of an existing
    facility of that type. Wet manure \u2192 AD+CCS where digester capacity exists, else HTL bio-oil;
    concentrated MSW with a WtE plant in range \u2192 WtE+CCS; dry residues near storage \u2192 BECCS /
    injection.</p>
    <h3>Caveats</h3>
    <p>Tonnages are modelled screening estimates, not measured inventories; storage capacities are
    theoretical and require site appraisal; facility biogenic CO\u2082 is capacity-estimated. This tool
    informs strategy \u2014 it does not substitute for project-level diligence.</p>`;

  // ============================================================
  // Init
  // ============================================================
  dom.feedHint.textContent = FEEDSTOCK_HINTS[state.feedstock];
  applyHash();
})();
