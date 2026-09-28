-- ============================================================
-- BROADCAST REALTIME STATUS UPDATES
-- ============================================================
-- The webhook updates broadcast_recipients as Meta sends sent /
-- delivered / read / failed events. The aggregate trigger updates the
-- parent broadcasts row. Publish both tables so the UI can update
-- without a manual page refresh.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'broadcasts'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE broadcasts;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'broadcast_recipients'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE broadcast_recipients;
  END IF;
END $$;
