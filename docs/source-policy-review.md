# Offer-source policy review

**Checked:** 2026-11-15. This is an operational source review, not a legal opinion.

## Current collectors

| Source | Code path and data | Access/robots evidence | Reuse status and action |
|---|---|---|---|
| Lidl | `backend/scraper/src/offers-worker.js` reads the Schwarz Group leaflet endpoint and official Lidl catalogue JSON. It stores catalogue titles, dates, product metadata, image/product URLs and source links. | `https://www.lidl.fr/robots.txt` was readable. It allows general paths except the listed disallows, but it is the Lidl website's file, not a policy for `endpoints.leaflets.schwarz`. Lidl's current online-shop terms say the site/app is protected and copying/downloading content requires prior express permission. That statement's exact scope over the public leaflet feed and limited catalogue metadata is unclear; public access is not an open-data licence. [Lidl robots.txt](https://www.lidl.fr/robots.txt), [Lidl terms, article 18](https://www.lidl.fr/c/conditions-generales-de-vente/s10016727), [Lidl site privacy notice on automated-access protections](https://www.lidl.fr/c/protection-des-donnees-site-et-application/s10056007). | **Not cleared.** Obtain written reuse permission or a published licence for the endpoint and fields. Verify the `leaflets.schwarz` host's robots policy and request limits. Until then, do not set `OFFERS_ENABLED_SOURCES=lidl` in production. |
| Franprix | Reads `www.franprix.fr` home/promotion pages and derives titles, excerpts, discounts and date ranges. | The official FAQ says customers can find a store's current catalogue by selecting that store; it does not publish a reuse licence. The direct `https://www.franprix.fr/robots.txt` request could not be read from this environment, so its directives remain unknown. The official FAQ's legal notice identifies Distribution Franprix as publisher; a separate franchise subsite reserves reproduction rights, but that does not establish the terms for the promotions pages. [Franprix promotion FAQ](https://faq.franprix.fr/fr-FR/Post/3795), [Franprix legal notice](https://faq.franprix.fr/fr-FR/Post/4833), [franchise-site legal notice](https://franchise.franprix.fr/mentions-legales/). | **Not cleared.** Obtain the current terms and written reuse permission or a published licence; verify robots rules and request limits for all hosts before enabling. |

The Crawlee product scraper has `respectRobotsTxtFile: true`. The direct-fetch offer collectors now use `fetchRespectingRobots`: they check each origin (including redirect targets), apply the most-specific `Allow`/`Disallow` rules and `Crawl-delay`, and fail closed when `robots.txt` is missing, unreadable, oversized or unavailable. This is a technical access control, not a reuse licence. The collectors remain disabled by default until written permission, host-specific robots checks and request limits are reviewed. A missing or unreadable robots file is never treated as permission.

## Current safeguards and limits

- No retailer source is activated by default. Product-crawl sources also require an explicit administrative approval with a non-empty review note before they can be enabled. Offer collectors require both `OFFERS_ENABLED_SOURCES` and `OFFERS_SOURCE_LICENSE_APPROVED`; both example values are empty. Do not enable a source only because its endpoint is public. The public source-list API omits internal licence-review notes.
- The expiry/one-year retention worker runs even when there are no offer sources enabled.
- Offers without stable source IDs are rejected; offers without verifiable dates remain drafts; discount percentages are not inferred from a price without evidence.
- Individual store availability is not inferred from a national or brand catalogue. Current collectors produce brand/online offers, shown through a matched brand key; a branch-specific offer needs a verified `placeId` and source evidence.
- Do not collect behind login, CAPTCHA, account or technical access controls; do not rotate identities, evade blocks, or increase collection volume without approved terms.

## Gate before activation

1. Record a written permission or explicit reuse licence that covers each data field, artwork and public/commercial use.
2. Check the exact robots file for every host used, not just the retailer homepage; implement and test robots enforcement in direct-fetch collectors.
3. Ask the source for allowed frequency, cache duration, attribution and a stable machine-readable feed where possible.
4. Use a staging-only dry run with low request counts. Compare dates, source links and scope with the official source; retain parser warnings and source timestamps.
5. Enable a source explicitly only after these checks are recorded and reviewed. If any terms or robots rules are ambiguous, keep it disabled and prefer a licensed open dataset or direct partnership.
