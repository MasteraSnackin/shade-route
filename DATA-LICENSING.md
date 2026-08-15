# Data licensing and third-party notices

This document records the principal data sources and external services used by
the ShadeRoute pilot. It is not legal advice and is not a substitute for checking
the provider's current terms before redistribution or production deployment.

## Scope

Third-party data permissions do not license ShadeRoute's source code. No
project-wide software licence has been selected and no `LICENSE` file exists.
Public visibility alone does not grant permission to reuse or redistribute the
software.

The dependency lock records declared package licences. It is not a complete
notice bundle for every transitive dependency or deployment artefact.

## Bundled data

### OpenStreetMap

Routes, map features and selected amenity context include data from
[OpenStreetMap contributors](https://www.openstreetmap.org/copyright), available
under the Open Data Commons Open Database Licence (ODbL). Retain the contributor
credit and ODbL link in displays and derived data distributions. Assess ODbL
share-alike obligations before distributing a derived database.

### Environment Agency LiDAR

The elevation packs derive from the Environment Agency 1 m LiDAR Composite DSM
and DTM, including surveys dated 2000–2022. The captured service identifiers are
preserved under `data/`; the DSM source is also linked from
[RESEARCHER.md](RESEARCHER.md). Environment Agency data is attributed to the
Environment Agency and used under the
[Open Government Licence v3](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).
Retain the source, survey-age limitation and OGL attribution with derived packs.

### Greater London Authority

- [Cool Space Data 2025](https://data.london.gov.uk/dataset/cool-space-data-2025-2z19p)
  is a historical extract governed by the London Datastore terms. The source did
  not state a dataset-specific licence in the captured metadata. Do not describe
  it as a current register or assume broader redistribution rights without
  reviewing the current terms.
- [Public Realm Trees, November 2025](https://data.london.gov.uk/dataset/london-public-realm-trees-2r45m)
  is recorded in the pack as Open Government Licence v3. ShadeRoute bundles
  `Highways` inventory points inside each pilot plus a 250 m selection buffer.
  Retain the GLA source and OGL attribution. The points are not proof of a current
  tree, canopy extent or shade.

Machine-readable source URLs, capture times, methods and selected source hashes
are retained in `public/data/context-*.json` and `release-manifest.json`.

## Live or optional providers

These services are not a general permission to cache or redistribute their
responses. The operator must review the current contract, attribution, retention
and quota terms before enabling them:

- [OS Names API](https://osdatahub.os.uk/docs/names/overview): Crown copyright
  and database-right attribution and the applicable OS Data Hub API terms.
- [Geoapify](https://www.geoapify.com/): retain the required `Powered by
  Geoapify` link and review plan-specific storage and usage terms.
- [Transport for London open data](https://tfl.gov.uk/info-for/open-data-users/):
  review TfL's transport-data terms and branding/attribution requirements.
- [Met Office Weather DataHub](https://datahub.metoffice.gov.uk/): review the
  selected product's licence, attribution, cache and redistribution terms.
- [UKHSA data dashboard](https://ukhsa-dashboard.data.gov.uk/): regional
  heat-health context is displayed separately from route scoring; review the
  dashboard's current reuse terms before storing or redistributing responses.
- [Department for Transport Street Manager Open Data](https://department-for-transport-streetmanager.github.io/street-manager-docs/open-data/):
  public journey-planning use requires an approved Open Data ingestion design.
  ShadeRoute keeps this provider disabled; an authorised user's short-lived JWT
  is not a substitute for that process.

API keys and tokens are credentials, not licences. Keep them server-side and do
not include them in source, screenshots, exports, logs or client bundles.

## Media and observations

The repository's screenshots, GIFs, video, slides and field-observation template
are project materials, not open-data inputs. No reuse permission is granted
until the owner selects a software/content licence. Field observations must also
be reviewed for personal and sensitive location information before publication.

## Release review

Before a public release or new dataset import:

1. verify each provider URL and current terms;
2. record the exact source, retrieval time, licence and processing method;
3. add required in-product and repository attribution;
4. test that source limitations are visible where decisions are made;
5. update the release manifest where covered artefacts change; and
6. obtain owner or legal review for unclear or conflicting terms.
