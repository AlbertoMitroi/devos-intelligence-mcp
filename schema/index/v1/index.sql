-- index.sqlite, index schema 1 (contract v1.2, docs/CONTRACT-v1.2.md "Index and query").
-- One statement per line. Engines create the tables of the "base" section exactly as written (names, columns,
-- column order); the "evidence" section is optional and used by consumers when present; the "system" section is
-- written by a federation only. Statements end with ";" and are compared after collapsing whitespace.

-- base
create table meta(key text primary key, value text not null);
create table entities(id text primary key, kind text, name text, container text, signature text, project text, origin text, json text);
create table declarations(id text primary key, entity text, context text, path text, line integer, col integer);
create table evidence(id text primary key, path text, line integer, col integer, end_line integer, end_col integer, method text, context text, text text);
create table relations(id text primary key, kind text, from_id text, to_id text, usage text, resolution text, context text, path text, line integer, declared_target text);
create table observations(id text primary key, kind text, project text, path text, line integer, json text);
create table links(id text primary key, kind text, via text, from_obs text, to_obs text, resolution text, reason text);
create table diagnostics(id text primary key, severity text, code text, scope text, state text, message text);
create table projects(id text primary key, record_type text, path text, json text);
create index relations_from on relations(from_id, kind);
create index relations_to on relations(to_id, kind);
create index declarations_entity on declarations(entity);
create index declarations_location on declarations(path, line);
create index entities_name on entities(name);
create index observations_kind on observations(kind);
create index links_from on links(from_obs);
create index links_to on links(to_obs);
create virtual table search using fts5(ref unindexed, kind unindexed, text);

-- evidence
create table relation_evidence(relation text, evidence text, primary key (relation, evidence));
create table observation_evidence(observation text, evidence text, primary key (observation, evidence));
create table link_evidence(link text, evidence text, primary key (link, evidence));
create table evidence_snippet(evidence text primary key, snippet text);
create index evidence_location on evidence(path, line);
create index relation_evidence_evidence on relation_evidence(evidence);
create index observation_evidence_evidence on observation_evidence(evidence);
create index evidence_snippet_snippet on evidence_snippet(snippet);

-- system
create table inputs(id text primary key, json text);
create table packages(id text primary key, package_id text, version text, consumer text, producer text, version_match text, resolution text, json text);
create table traces(id text primary key, start text, end text, resolution text, json text);
