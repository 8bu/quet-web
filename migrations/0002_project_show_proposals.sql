-- projects.show_proposals: 1 = collaborators see model proposals; 0 (default) = independent labelling.
ALTER TABLE projects ADD COLUMN show_proposals INTEGER NOT NULL DEFAULT 0;
