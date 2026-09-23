# Draft v1 outage operating procedure

**Status: requires center approval and a real-device rehearsal before use.** This draft does not establish that the supplied Kumon requirements have been met. The center must approve an independently accessible source of necessary attendance/pickup information and a method for documenting observations during an outage.

Cloudflare v1 has no durable offline attendance queue or automatic offline synchronization. It does not save an arrival or departure merely because someone pressed a button. A roster shown during a connection failure can be stale.

## Before the first operating day

The center owner appoints an outage lead and backup, records their contact details, and approves the following with the appropriate reviewer:

- A controlled contingency roster/information source accessible without this application, the same failed sign-in service, or the same unavailable network. Include only necessary student identification, pickup restrictions, verified collection authority, and essential contact information.
- Who prepares that source, when it is refreshed, how its preparation time is displayed, where it is held, and who can access it. Define secure replacement, storage, access logging where appropriate, and disposal under the center's retention policy.
- A contemporaneous observation record with student reference, actual observed time, arrival/departure, observing staff member, pickup verification, restrictions/exception details, and later reconciliation outcome. Approve its format explicitly. It is a temporary contingency method, not the routine digital attendance baseline.
- A physical headcount/identity-check procedure, an authorized pickup procedure, a way to contact the responsible manager/guardian, and escalation steps for missing or uncertain students.
- A decision rule for stopping routine check-ins or releases when physical presence, student identity, or pickup authority cannot be verified. Staff follow the center's approved safety and emergency procedures; this software does not determine release authority.

An old list does not prove current presence. The contingency source supplies necessary information; staff must maintain current presence through observation and the approved procedure. A Google Drive connection or encrypted nightly backup is **not** an immediately usable emergency roster.

## Recognize and contain the interruption

1. Read the connection banner and last refresh time. Tell the responsible manager that the displayed presence may be out of date.
2. Verify actual physical presence and identify any students whose status is uncertain. Do not treat the last displayed count as a current headcount.
3. Begin the approved contingency process. Record arrivals and departures when observed and identify the staff observer. Do not invent earlier times later.
4. Use the approved independent information source to check identity and pickup authority. Missing contact data or unverified authority does not become permission. Record and escalate exceptional departures separately from authorized pickup.
5. Use **Try again** to refresh when appropriate. Do not clear browser storage, reinstall the kiosk, or repeatedly reload a window that has an unresolved attendance request.

## A button was pressed but no confirmation returned

Treat the result as unknown: the server may have saved it even though the response was lost.

1. Keep the attendance dialog open and retain its displayed request reference. Do not create a second observation for the same event.
2. Use **Check result**. If no confirmed result is found, use **Retry this request** only from that existing dialog. It sends the original reference and observation again.
3. A failed check, expired sign-in, or access-denied response is not confirmation that the event was absent. Reverify access and resolve the same request. Kiosk staff should unlock as the person who made the original observation.
4. Other attendance actions remain blocked while the request is unresolved. Continue the center's approved contingency procedure rather than bypassing that protection.
5. If the browser or device closes, the application cannot promise recovery of its in-memory request. Give the manager the contemporaneous record, student reference, observer, time, and any retained request reference. The manager checks server history before adding or correcting anything.

An observed student departure must still be documented if there was no recorded arrival. Use the exceptional-departure process after connectivity is restored and follow manager review; it is not permission to release a student.

## Restore service and reconcile

1. Reestablish network and named staff access. An enrolled kiosk still requires an individual staff PIN. Use a manager-approved replacement device if necessary.
2. Refresh successfully, then compare the current physical headcount, returned roster, and contingency records. A successful refresh alone does not reconcile missing observations.
3. Resolve unknown request references first. Check original observations and recent visits so a successfully saved event is not entered twice.
4. For each contingency observation, record whether it was already present, entered from a documented observation, corrected, or still unresolved. Preserve actual observation time, server receipt time, observer, and the original contingency evidence.
5. The current entry API accepts observation times within the past 24 hours. Older times need manager handling through the correction/recovery procedure. Do not change the date to make a rejected record fit. A correction to an existing visit does not manufacture a missing original observation.
6. Review unmatched departures, pickup exceptions, duplicate/conflicting records, and differences after any database restore. Close the incident only when each student's presence and each source observation has a disposition.

Routine attendance remains contemporaneous. The availability of earlier-time entry or a correction API is not approval to operate by retrospective recordkeeping. Obtain appropriate review of this contingency approach against the supplied requirement.

## Rehearsal and sign-off

Engineering tests: unavailable Wi-Fi/internet; Access denial/expiry; locked or revoked kiosk; lost write response; repeated same-reference retry; interrupted import; stale roster; restored database missing more recent records. Test the actual iPad and network, not only a desktop browser.

Center demonstration: retrieve the approved independent information source; verify physical presence; check restricted pickup; document an observed event immediately; escalate uncertainty; reconcile the incident without duplicate or invented attendance.

Record the center, lead/backup, independent source and refresh rule, approved observation format, supported device/browser, scenario/date, observed gaps, corrective actions, reviewer, and approval date. Until these are completed, outage handling remains an unresolved readiness item.
