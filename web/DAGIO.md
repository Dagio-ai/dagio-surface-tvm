# Dagio TVM Web Runtime

`@dagio-ai/surface-web-runtime` is built from Apache TVM at commit
`7e06fc6c1420d0188eb9d889bd74e2e1fb76e448`. The fork adds optional byte progress to the existing
OPFS artifact writer. The package carries the upstream Apache licence and NOTICE.

Run `npm ci --ignore-scripts`, `npm run prepare`, `npm run check:types`, `npm run build` and `npm test`
from `web/` to qualify a release.
