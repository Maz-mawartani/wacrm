-- Persist non-body template send metadata for broadcasts.
--
-- Body placeholder mappings already live in broadcasts.template_variables.
-- Media headers and dynamic button parameters are separate WhatsApp
-- template components, so keep them as nullable JSONB columns rather
-- than overloading the existing body-variable map.

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS template_header JSONB,
  ADD COLUMN IF NOT EXISTS template_buttons JSONB;

