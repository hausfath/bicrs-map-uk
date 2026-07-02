# UK BiCRS Atlas

An interactive screening map of **Biomass Carbon Removal and Storage (BiCRS)** opportunity across the
United Kingdom: recoverable biomass feedstock supply, CO₂ storage access, and a transparent
"best use of biomass" recommendation for each of the UK's 41 NUTS-2 / ITL-2 regions.

**Live map:** https://hausfath.github.io/bicrs-map-uk/
**Two-pager:** [docs/UK_BiCRS_Pathways_Two_Pager.md](docs/UK_BiCRS_Pathways_Two_Pager.md) — the most
promising UK pathways: feedstock availability, retrofit opportunities, and CO₂ potential by pathway.

This is the United Kingdom subset of [Frontier's BiCRS Atlas](https://github.com/hausfath/biomass_map)
(global / North America / Europe scopes), packaged standalone for sharing with UK stakeholders.

## What the map shows

- **Feedstock supply** (choropleth, Mt/yr): agricultural residues, forestry residues, biogenic MSW,
  animal manure, and sewage biosolids per region — JRC ENSPRESO NUTS-2 distribution scaled to UK
  country totals; purpose-grown energy crops are excluded by design.
- **Best-use recommendation** per region, encoding Frontier's KPI ranking (CDR efficiency ›
  emissions-avoiding co-products › co-benefits), modulated by feedstock moisture and density,
  storage transport cost, nutrient status, and retrofit availability. Click any region for the full
  rationale, ranked alternatives, and delivered-cost estimates.
- **Overlays:** biogenic point sources (Drax, Lynemouth, WtE fleet, AD capacity), large WWTPs,
  CO₂ storage projects (Endurance/East Coast Cluster, HyNet, Acorn, Viking), CO2StoP storage-unit
  polygons, and the routed multimodal CO₂ transport path for a selected region.

## Running it

No build or server needed — open `src/index.html` in a browser (or serve the repo root). All data is
bundled as static JS.

## Regenerating the data

Data bundles are extracted from the parent BiCRS Atlas repo:

```
python3 scripts/build_uk_from_parent.py "/path/to/BiCRS Map"
```

Sources: Eurostat GISCO (geometry), JRC ENSPRESO (biomass), Eurostat population (MSW/biosolids),
JRC CO2StoP (storage units), curated storage projects & biogenic facilities, EEA/EMODnet UWWTD
(WWTPs). See the in-app **Methodology & sources** for details and caveats.

**Caveats:** screening-level estimates, not measured inventories; storage capacities are theoretical;
facility biogenic CO₂ is capacity-estimated. This tool informs strategy — it does not substitute for
project-level diligence.
