# Code deployed in production

Read-only copies of Edge Functions as production runs them. Nothing here is deployed or imported.
To change a function, edit `supabase/functions/`.

## sub-invoice-submit v7 (running in production)

Deployed on 01/11/2026 from commit b7abcd3 with the live build, `verify_jwt` false. There is no copy here:
the build of that commit is the source. SHA-256 of the deployed files, read back after the deploy:

| File | SHA-256 |
|---|---|
| `index.ts` | `f3f4fb2484783a399a2ded3a5fec871000e87082ac905e4b82511c4597bf77f8` |
| `request.ts` | `64c64c0fe04dff2076531ff68060adc0c7b389ac7bec3b947f4078259abf2f38` |
| `email-transport.ts` | `5d847c748584c6ff6e1849f857949dc3e1e47b080928c7fa3d4503fb435feb82` |

## sub-invoice-submit v6 (rollback target)

No longer running. Kept so it can be redeployed: see `supabase/rollbacks/`. Read on 01/11/2026 with the
Supabase `get_edge_function` tool. Production deployed it on 20/10/2026. The files are kept byte for byte,
including old comments such as "TEST FIRST".

| File | SHA-256 |
|---|---|
| `index.ts` | `bb83806594b0d5f7d28f820f93552f3682a7f09683a5470dc734474b688adc08` |
| `request.ts` | `f21707b68bedb8c17fda25194ae51de8565b100cdc9a7790bbe8dc714d8e516d` |
| `email-transport.ts` | `5d847c748584c6ff6e1849f857949dc3e1e47b080928c7fa3d4503fb435feb82` |

It fails on alerts of kind `email_changed_by_worker`, so restore the database first.
