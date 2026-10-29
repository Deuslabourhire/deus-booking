# Subcontractor migrations

The files in this folder are the subcontractor module's migrations **exactly as production
executed them**. Each file's name uses the version recorded in production
(`supabase_migrations.schema_migrations`), and each file's bytes are identical to the statement
stored there.

| Version | Name |
|---|---|
| 20261018081255 | subcontractor_invoices |
| 20261018081342 | subcontractor_payments |
| 20261018081444 | subcontractor_link_expiry_durations |
| 20261018081504 | subcontractor_admin_corrections |
| 20261018081533 | subcontractor_email_resend |
| 20261020102601 | subcontractor_admin_grouped_invoices |
| 20261020124229 | subcontractor_admin_job_rate_correction |
| 20261027222146 | subcontractor_adjust_lock_order |

## Rules

- **Do not edit a migration that production has already run.** Fix things in a new migration.
- **Do not run `supabase db push` or `supabase db reset` against production from this repository.**
  Production has 49 earlier migrations (bookings, CRM, invoices, follow-ups) that are not in
  this folder, and the subcontractor migrations need objects created by them (for example
  `user_roles`). This folder is a record of the subcontractor module, not a full rebuild of the
  database.
- A new migration gets its file here with the same version and name that production records.

## Comments that are out of date

Some files still carry comments from before they were applied. They are kept because the file must
match what production ran:

- `20261020102601_…grouped_invoices.sql` says "TEST FIRST (deus-authtest); NOT on production" and
  calls itself version 20261020120000. It is applied in production as 20261020102601.
- `20261020124229_…job_rate_correction.sql` refers to the grouped-invoice migration as
  20261020120000.
- `20261027222146_…adjust_lock_order.sql` says "REVIEW DRAFT ONLY … No database changes have been
  applied". It is applied in production.
- Some files refer to earlier files by their old local versions (20261016130000 … 20261017150000).
  So does `supabase/scheduled/sub_alert_retry_cron.sql`.

## Checking a file against production (read-only)

```sql
select version, name, md5(statements[1]) as md5, length(statements[1]) as chars
from supabase_migrations.schema_migrations
where name like 'subcontractor%'
order by version;
```

Compare with `md5sum supabase/migrations/*.sql`. Each pair must match.
