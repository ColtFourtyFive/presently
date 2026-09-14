# Vendor research, part B

Research date and access date for all sources: 2026-09-14. Sources below are public vendor pages or vendor help/documentation linked from those pages. These are verified statements of what vendors publish, not independent product tests or certification that a product meets Kumon's requirements. No accounts, trials, purchases, or outreach were used. Public text snapshots are in `research/vendor_sources/`.

## Findings that affect the proposed Kumon CRM

1. Attendance should share a student and guardian record with enrollment, scheduling, communications, and account administration. Playground, Famly, Daily Connect, Jumbula, and EZChildTrack all connect at least several of these functions. This supports the user's broader CRM objective, although the supplied PDF mandates attendance requirements only.
2. Separate four different capabilities in requirements and acceptance testing: displaying a credential without connectivity, recording a new event without connectivity, reading a current or cached roster without connectivity, and restoring backed-up historical records. One does not prove the others. EZChildTrack documents offline display of a saved parent QR code. Famly explicitly requires connectivity to read its evacuation information.
3. Record a child's arrival or departure separately from the adult or staff member who records it. Playground documents timestamps and signer attribution; Jumbula documents pickup methods and authorized adults. A student identifier alone is not authorization to release the child.
4. PIN/QR and bulk family workflows reduce arrival queues, but the staff workflow must verify actual presence and actual departure. A valid PIN or QR is an identification input, not proof of physical attendance. Rotating codes can reduce remote reuse; they do not replace staff oversight.
5. Build a correction workflow that preserves the original event, records the correcting staff member, captures a reason, and distinguishes reported occurrence time from entry time. Playground and Famly allow later editing. Those vendor editing features do not by themselves establish an immutable audit trail or satisfy the supplied PDF's actual-arrival requirement.
6. Exports and long-term retention require separate acceptance tests. A vendor's ability to export a report does not establish two-year record retention, post-termination access, backup restoration times, or completeness of audit history.
7. APIs exist in this market, but no source reviewed establishes an available Kumon corporate API, permission to integrate with Kumon systems, or an approved substitute for any corporate system. Treat a Kumon connection as an unresolved dependency.

## Playground

**Published capabilities verified.** Its attendance help article documents student check-in/out and staff clock-in/out as separate record types. Admin dashboard, mobile app, and shared kiosk write to the same attendance record. Events are timestamped and attributed to the family or staff signer. Kiosk mode supports QR and PIN. Staff see signed-in, signed-out, and absent students; a child profile contains attendance and transition logs. Reports support dates, printing, and export. Administrators can add, edit, and delete attendance records. A rotating QR option refreshes every minute, and a geofence can restrict mobile check-ins. [V06a]

The attendance product page lists mobile/tablet/kiosk entry, family self-check-in, multiple-child entry, guardian names and timestamped signatures, classroom transitions, ratio alerts, and export/print/email reports. The API page advertises lead capture, data synchronization, custom dashboards, billing exports, APIs, and an MCP server. Specific attendance endpoint coverage, commercial access, authentication details, and API service levels were not verified. [V06b, V06c]

**Unknowns.** No two-year contractual attendance retention commitment or center-side offline attendance/roster capability was verified. Playground's public help search for “offline” returned payment and support topics, which is not evidence that offline attendance is impossible. Current pricing was not verified.

**Kumon design lesson.** Use one student presence state across staff and kiosk screens, while keeping staff timekeeping separate. Provide a locked kiosk, a distinct staff recovery route, and an exportable attendance history with signer attribution. Do not copy unrestricted destructive edits into the proposed audit design.

- V06a. Attendance overview: https://help.tryplayground.com/en/articles/16111397-attendance-overview
- V06b. Attendance product: https://www.tryplayground.com/solutions/attendance
- V06c. API: https://www.tryplayground.com/solutions/api

## Famly

**Published capabilities verified.** Its US attendance page lists a PIN-protected sign-in screen for parents, guardians, and staff; dynamic QR entry; expected versus actual attendance; child/staff ratios; registration forms; occupancy forecasts; and lead/waitlist management. [V07a]

Its QR help article documents a tablet QR code that changes every five seconds and a parent flow that expires after 15–30 minutes. A static printed QR option also exists. Completed check-in updates the room overview and child's activity feed. Its attendance editing article allows staff to change, add, or remove check-in/out times and record absence types. [V07b, V07c]

For evacuation, Famly documents a live evacuation report and signed-in overview. Its guide explicitly says an internet connection is required, recommending a phone with data or a hotspot. This establishes a dependency for this workflow; it does not establish a local offline roster. [V07d]

Famly publishes a GraphQL API with children, contacts, inquiries, check-ins, sites, and other query areas. The reference documents site and organization tokens, permission configuration, token expiry, and token deletion. Availability may need enabling on the account. [V07e]

**Unknowns.** Two-year contractual attendance retention and center-side offline event capture were not verified. The US pricing page uses a per-child calculator and showed $49/month in its initial state, but the associated selected child count was not recoverable from the rendered text. This is not a center quote or a reliable total-cost assumption. [V07f]

**Kumon design lesson.** Keep scheduled attendance separate from observed presence, and make current presence easy to retrieve during evacuation. Design and test connectivity loss explicitly. If parent QR entry is offered, bind credentials to the center and a short lifetime, and retain staff verification of arrival/departure.

- V07a. Enrollment and attendance: https://www.famly.co/us/platform/enrollment-attendance
- V07b. QR check-in/out: https://help.famly.co/en-us/articles/8075420-qr-code-check-in-out-screen
- V07c. Edit attendance: https://help.famly.co/en-us/articles/5477196-edit-a-child-s-check-in-or-out-time
- V07d. Emergency workflow: https://help.famly.co/en-us/articles/4912356-in-case-of-emergency
- V07e. Public API reference: https://docs.famly.co/
- V07f. US pricing: https://www.famly.co/us/pricing

## Daily Connect

**Published capabilities verified.** Its attendance product page documents parent QR or unique PIN sign-in, optional digital signatures and parent surveys, current classroom membership, ratio monitoring/alerts, automatically saved attendance reports, and custom reports for billing, compliance, or export. It also describes sending a child's daily activity email when the child signs out. The homepage describes enrollment forms, digital signatures, deposits, waitlists, billing, and parent communication. [V08a, V08b]

**Pricing snapshot.** The pricing page displayed Professional at $16/month billed annually, with ten children included and then $1.60 per child. Enterprise pricing requires contact. Pricing depends on active children and locations; its FAQ says only children with recorded activity in that month are counted. Standard payment-processing fees apply when accepting parent payments. These are published observations, not a quote for the user's center. [V08c]

**Unknowns.** No explicit two-year attendance retention commitment, center-side offline recording or roster capability, or public supported attendance API was verified. The report-export capability does not prove a complete operational API or an immutable audit history.

**Kumon design lesson.** Pair low-friction parent entry with an immediate staff present-student view. Keep routine sign-out messages optional and event-triggered. Use a durable notification queue so a failed message does not undo or delay an attendance record. Billing and payment functionality belongs in separately approved CRM scope.

- V08a. Attendance: https://en.dailyconnect.com/sign-in-attendance-tracking
- V08b. Homepage: https://en.dailyconnect.com/
- V08c. Pricing: https://en.dailyconnect.com/pricing

## Jumbula

**Published capabilities verified.** The Business App page distinguishes session attendance from dismissal and check-in/out. Staff can mark present, late, absent, or excused; view records by program, session, group, or date; and add exception notes. Dismissal displays authorized pickup options and supports guardian, bus, authorized adult, or self-check-out. The CICO view tracks checked-in, checked-out, and pending states, timestamps, and the person or method handling pickup/drop-off. [V09a]

The same page lists scan-code/PIN entry, kiosk mode, participant profiles, registration forms, waivers, role-based restrictions, multi-location switching, and reports. Its homepage lists registration, payments, campaigns, and custom API integration. The linked public API documentation lists families, participants, parents, authorized pickups, and emergency contacts. It also contains unrelated example sections, so treat endpoint support, attendance coverage, and commercial availability as needing confirmation. [V09a, V09b, V09c]

**Pricing snapshot.** The pricing page displays monthly Pay As You Go at $15, Rise at $150, and Ascend at $285, with processing fees potentially applicable. It also lists a Business App five-seat add-on at $30 and separate enrollment/SMS add-ons. The base price alone is not an equivalent attendance-system cost. Annual pricing and bundled feature eligibility should be confirmed through the interactive plan comparison. [V09d]

**Unknowns.** Two-year attendance retention, center-side offline attendance/roster behavior, immutable correction history, and a supported attendance API were not verified.

**Kumon design lesson.** Model attendance sessions and release authorization separately. Support an explicit authorized self-dismissal policy only if the center approves it. Restrict sensitive student fields by role. A child changing between math and reading activities should not create a false center departure.

- V09a. Business App: https://jumbula.com/jb-business-app/
- V09b. Homepage: https://jumbula.com/
- V09c. Vendor-linked API documentation: https://app.theneo.io/hassan-jumbula-com/jumbula2/getting-started/introduction
- V09d. Pricing: https://jumbula.com/pricing/

## EZChildTrack

**Published capabilities verified.** Its attendance page lists QR scanning on computers/tablets/phones, predefined check-in/out codes, barcode badges, and card readers. Adults can check in/out multiple children they are authorized to pick up. It supports attendance by activity, multiple reports, staff attendance, and late-pickup billing. Its iPad page explicitly describes real-time attendance entry and multiple-participant entry. [V10a, V10b]

Parents can save their personalized QR page and present it without on-site internet. This is evidence of an offline-presentable parent credential only. It does not demonstrate that a center's scanner, attendance service, or roster can record/read events while disconnected. [V10a]

Its features page lists centralized family records, registration/enrollment, parent portal, communications, account balances, report exports to Excel, and authorized pickup tracking. The cloud page says information is backed up and recoverable after disaster, but provides no tested recovery target or backup retention schedule. [V10c, V10d]

**Unknowns.** No two-year contractual attendance retention term, center-side offline event capture/current-roster availability, public supported API, or numerical pricing was verified.

**Kumon design lesson.** Support inexpensive tablets and scanners without tying the identity model to a particular device. A sibling transaction should create individually attributable student events. Make recovery and export requirements measurable, including a simulated outage and restore test, instead of accepting a general cloud-backup claim.

- V10a. Attendance: https://www.ezchildtrack.com/attendance-tracking.html
- V10b. iPad interface: https://www.ezchildtrack.com/ipad-interface.html
- V10c. Features: https://www.ezchildtrack.com/features.html
- V10d. Cloud storage and backups: https://www.ezchildtrack.com/cloudbased.html

## Requirements boundary

The supplied PDF is an attendance baseline and a non-exhaustive informational vendor list. It does not require purchasing from this list. It requires reviewable attendance records retained for at least two years and a reasonable preservation/availability approach when the primary system is unavailable. Enrollment pipelines, tuition billing, CRM notes, guardian release rules, offline digital event capture, audit-log mechanics, dashboards, and API architecture are proposed product decisions unless another supplied source establishes them. Mark these as recommendations or assumptions, not Kumon mandates. The PDF's approximately $25–$75 monthly range is illustrative and must not serve as a current vendor quote or the in-house project's approved budget.
