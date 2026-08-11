//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

const Sqlite = @import("Sqlite.zig");

const log = @import("../../../support/log.zig");

pub fn run(conn: Sqlite.Conn) !i64 {
    try conn.exec("pragma journal_mode=wal", .{});
    try conn.exec("pragma foreign_keys=on", .{});

    var version = try getVersion(conn);
    if (version < 2) {
        try migrateV2(conn);
        version = 2;
    }
    if (version < 3) {
        try migrateV3(conn);
        version = 3;
    }
    if (version < 4) {
        try migrateV4(conn);
        version = 4;
    }
    return version;
}

fn getVersion(conn: Sqlite.Conn) !i64 {
    const modern_exists = "select exists (select 1 from sqlite_schema where type='table' and name='schema_migrations')";
    if (try conn.scalar(bool, modern_exists, .{}) orelse false) {
        return try conn.scalar(i64, "select max(version) from schema_migrations", .{}) orelse error.CorruptDatabase;
    }

    const exists_sql = "select exists (select 1 from sqlite_schema where type='table' and name='migrations')";
    if (try conn.scalar(bool, exists_sql, .{}) orelse false) {
        if (try conn.scalar(i64, "select max(id) from migrations", .{})) |version| {
            return version;
        }

        log.fatal(.storage, "corrupt database", .{ .engine = "sqlite", .note = "The sqlite database has an existing but empty `migrations` table" });
        return error.CorruptDatabase;
    }

    const create_sql =
        \\ create table migrations as
        \\ select 1 as id, current_timestamp as created_at
    ;
    conn.exec(create_sql, .{}) catch |err| {
        log.fatal(.storage, "migrate", .{ .err = err, .sqlite = conn.lastError(), .step = "create migrations" });
        return err;
    };

    return 1;
}

fn migrateV4(conn: Sqlite.Conn) !void {
    const sql =
        \\begin immediate;
        \\create table schema_migrations (
        \\  version integer primary key,
        \\  applied_at text not null
        \\) strict;
        \\insert or ignore into schema_migrations(version, applied_at) select cast(id as integer), cast(created_at as text) from migrations;
        \\create table sessions (
        \\  session_id blob primary key,
        \\  profile_id text not null references profiles(profile_id) on delete cascade,
        \\  created_at integer not null,
        \\  updated_at integer not null,
        \\  resumable integer not null default 0,
        \\  state integer not null
        \\) strict;
        \\create table session_storage (
        \\  session_id blob not null references sessions(session_id) on delete cascade,
        \\  origin text not null,
        \\  key text not null,
        \\  value text not null,
        \\  update_seq integer not null,
        \\  primary key(session_id, origin, key)
        \\) strict, without rowid;
        \\insert into schema_migrations(version, applied_at) values (4, current_timestamp);
        \\commit;
    ;
    conn.exec(sql, .{}) catch |err| {
        log.fatal(.storage, "migrate", .{ .err = err, .sqlite = conn.lastError(), .step = "v4 migration metadata and session schema" });
        conn.exec("rollback", .{}) catch {};
        return err;
    };
}

fn migrateV2(conn: Sqlite.Conn) !void {
    const sql =
        \\begin immediate;
        \\create table if not exists profiles (
        \\  profile_id text primary key,
        \\  created_at integer not null,
        \\  updated_at integer not null
        \\) strict;
        \\create table if not exists local_storage (
        \\  profile_id text not null references profiles(profile_id) on delete cascade,
        \\  origin text not null,
        \\  key text not null,
        \\  value text not null,
        \\  update_seq integer not null,
        \\  primary key(profile_id, origin, key)
        \\) strict, without rowid;
        \\create table if not exists cookies (
        \\  profile_id text not null references profiles(profile_id) on delete cascade,
        \\  partition_site text not null default '',
        \\  name text not null,
        \\  domain text not null,
        \\  path text not null,
        \\  value text not null,
        \\  expires real,
        \\  secure integer not null,
        \\  http_only integer not null,
        \\  same_site integer not null,
        \\  source_secure integer not null,
        \\  source_port integer not null,
        \\  partitioned integer not null,
        \\  update_seq integer not null,
        \\  primary key(profile_id, partition_site, name, domain, path)
        \\) strict, without rowid;
        \\create index if not exists cookies_profile_expiry on cookies(profile_id, expires);
        \\insert into migrations(id, created_at) values (2, current_timestamp);
        \\commit;
    ;
    conn.exec(sql, .{}) catch |err| {
        conn.exec("rollback", .{}) catch {};
        log.fatal(.storage, "migrate", .{ .err = err, .sqlite = conn.lastError(), .step = "v2 browser state" });
        return err;
    };
}

fn migrateV3(conn: Sqlite.Conn) !void {
    // v2 declared string payloads as STRICT BLOB while the Zig binding
    // intentionally uses sqlite3_bind_text. Rebuild both tables atomically so
    // existing databases retain data and enforce the representation we use.
    const sql =
        \\begin immediate;
        \\drop index if exists cookies_profile_expiry;
        \\create table local_storage_v3 (
        \\  profile_id text not null references profiles(profile_id) on delete cascade,
        \\  origin text not null,
        \\  key text not null,
        \\  value text not null,
        \\  update_seq integer not null,
        \\  primary key(profile_id, origin, key)
        \\) strict, without rowid;
        \\insert into local_storage_v3 select profile_id, origin, key, cast(value as text), update_seq from local_storage;
        \\drop table local_storage;
        \\create table local_storage (
        \\  profile_id text not null references profiles(profile_id) on delete cascade,
        \\  origin text not null,
        \\  key text not null,
        \\  value text not null,
        \\  update_seq integer not null,
        \\  primary key(profile_id, origin, key)
        \\) strict, without rowid;
        \\insert into local_storage select * from local_storage_v3;
        \\drop table local_storage_v3;
        \\create table cookies_v3 (
        \\  profile_id text not null references profiles(profile_id) on delete cascade,
        \\  partition_site text not null default '',
        \\  name text not null,
        \\  domain text not null,
        \\  path text not null,
        \\  value text not null,
        \\  expires real,
        \\  secure integer not null,
        \\  http_only integer not null,
        \\  same_site integer not null,
        \\  source_secure integer not null,
        \\  source_port integer not null,
        \\  partitioned integer not null,
        \\  update_seq integer not null,
        \\  primary key(profile_id, partition_site, name, domain, path)
        \\) strict, without rowid;
        \\insert into cookies_v3 select profile_id, partition_site, name, domain, path, cast(value as text), expires, secure, http_only, same_site, source_secure, source_port, partitioned, update_seq from cookies;
        \\drop table cookies;
        \\create table cookies (
        \\  profile_id text not null references profiles(profile_id) on delete cascade,
        \\  partition_site text not null default '',
        \\  name text not null,
        \\  domain text not null,
        \\  path text not null,
        \\  value text not null,
        \\  expires real,
        \\  secure integer not null,
        \\  http_only integer not null,
        \\  same_site integer not null,
        \\  source_secure integer not null,
        \\  source_port integer not null,
        \\  partitioned integer not null,
        \\  update_seq integer not null,
        \\  primary key(profile_id, partition_site, name, domain, path)
        \\) strict, without rowid;
        \\insert into cookies select * from cookies_v3;
        \\drop table cookies_v3;
        \\create index cookies_profile_expiry on cookies(profile_id, expires);
        \\insert into migrations(id, created_at) values (3, current_timestamp);
        \\commit;
    ;
    conn.exec(sql, .{}) catch |err| {
        log.fatal(.storage, "migrate", .{ .err = err, .sqlite = conn.lastError(), .step = "v3 text payloads" });
        conn.exec("rollback", .{}) catch {};
        return err;
    };
}
