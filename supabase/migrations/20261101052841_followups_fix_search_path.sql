-- Audit item P1: pin search_path on the two follow-up trigger functions.
-- Rollback:
--   ALTER FUNCTION public.create_post_job_review_followup() RESET search_path;
--   ALTER FUNCTION public.create_quote_no_response_followup() RESET search_path;
ALTER FUNCTION public.create_post_job_review_followup() SET search_path = '';
ALTER FUNCTION public.create_quote_no_response_followup() SET search_path = '';
