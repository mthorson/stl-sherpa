-- Exact-duplicate detection (issue #22).
--
-- A SHA-256 over the file's raw bytes, computed during scan for new or
-- changed files. Stored separately from the legacy `sha256` column (which was
-- only ever wired for a lazy thumbnail-render path that never shipped) so the
-- duplicate-detection query has a column it fully owns and always populates.
--
-- The index makes the "group files sharing a hash" query cheap. NULLs (files
-- not yet hashed, or whose content could not be read) are excluded from the
-- duplicate grouping, so a partial index keeps it tight.

ALTER TABLE files ADD COLUMN content_sha256 TEXT;

CREATE INDEX idx_files_content_sha
  ON files(content_sha256)
  WHERE content_sha256 IS NOT NULL;
