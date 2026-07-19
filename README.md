# Jobs Near You

Search Gross Domestic Product by county and industry, 2001–2024. See what drives each county's economy — from manufacturing and agriculture to professional services and government.

## Search Modes

- **By Name** — Search any county to see its GDP breakdown by industry
- **By State** — Browse counties ranked by GDP within each state
- **Near Me** — Find economic data for counties near any US address

## Data Source

All data is from the [U.S. Bureau of Economic Analysis (BEA)](https://www.bea.gov/data/gdp/gdp-county-metro-and-other-areas) — CAGDP2 dataset, 2001–2024.

## Pipeline

The `pipeline/build.py` script downloads Census LODES data, extracts county-level GDP by industry, and pre-aggregates into static JSON files for client-side search.

```bash
# Download BEA data and build the site
cd pipeline
python3 build.py
```

## Privacy

This is a static lookup tool. No data is collected, no searches are tracked, no cookies are set.
All data displayed is from publicly available BEA records.

## License

MIT
