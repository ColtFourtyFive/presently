# Presently: student check-in and check-out for Kumon centers

Presently is a check-in and check-out system for tutoring centers. It is built around the baseline requirements franchisees must certify each year. It is sold once and installed into the buyer's own Cloudflare account, with one installation per franchise business. An installation can hold several locations under one owner.

Presently is an independent product. It is not affiliated with, endorsed by, or sponsored by Kumon North America, Inc. or Kumon Institute of Education Co., Ltd. "Kumon" is a trademark of its owner and is used here only to describe compatibility.

## Repository layout

| Path | Purpose |
| --- | --- |
| `cloudflare/` | The product: a Hono Worker, D1 database, R2 backups, and a React client |
| `deferred/` | Earlier editions, research and plans that are not part of the product. See [deferred/README.md](deferred/README.md). |

See [cloudflare/README.md](cloudflare/README.md) to run, test, and install the product.
