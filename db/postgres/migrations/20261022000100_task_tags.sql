-- v1.1 task labels. The API normalizes and validates tag values before writing;
-- the database constraint is a final backstop for out-of-band writes.
ALTER TABLE tasks
    ADD COLUMN tags TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
    ADD CONSTRAINT tasks_tags_max_20 CHECK (cardinality(tags) <= 20);

CREATE INDEX idx_tasks_tags_gin ON tasks USING GIN (tags);
