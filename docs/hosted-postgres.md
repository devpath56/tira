# Setting up tira's database (hosted Postgres)

tira keeps its data in one Postgres database, hosted from day one. Any managed Postgres works;
Neon is a good start: plain Postgres, with a free tier. You do these steps yourself, and the
connection string stays with you: never paste it into a chat, a PR or a commit.

## 1. Make the database

1. Sign up at neon.tech and create a project (any name, e.g. `tira`; pick the region nearest you).
2. On the project's dashboard, open **Connect**. Choose the default branch and database, turn
   connection pooling off, and copy the **connection string**. It looks like
   `postgresql://USER:PASSWORD@HOST/DBNAME?sslmode=require`. Change `sslmode=require` to
   `sslmode=verify-full`: the same encryption, plus a check that the server is really Neon (and
   the database driver stops warning about it). tira needs one or the other for a database on
   another machine.

You don't need Neon's own CLI (`neon init`, `neon deploy`): tira only needs the connection string.

## 2. Give it to tira

Either one:

- **Your shell** (every terminal): add `export TIRA_DATABASE_URL='<the string>'` to `~/.zshrc`,
  then open a new terminal.
- **The repo's `.env`** (this folder only): make a file named `.env` at the repo's top with one
  line, `TIRA_DATABASE_URL=<the string>`. It's in `.gitignore`, so git never sees it. tira reads it
  by itself; a setting in your shell wins.

Check it:

```
node scripts/tira.ts log
```

The first command makes tira's tables in schema `tira`. tira never prints the string; if
something's wrong it says what to set, not what is set.

## 3. Bring the old demo over (once)

```
TIRA_SCHEMA=demo node scripts/tira.ts import <path to the 4750 demo's live.db>
```

It copies every event as it was, into the empty `demo` schema, and prints `same` for each stream
whose fingerprint matches before and after. Run it again and it adds nothing. Once it says
`same`, you can delete the old `.db` file yourself. To see the demo:
`TIRA_SCHEMA=demo node scripts/tira.ts serve --stream tasktree-dash --actor isha`.

## What tira refuses, and why

- A SQLite file (`--db something.db`, or a `.db` in `$TIRA_DB`): tira keeps its data in Postgres
  only, so nothing lands in a file nobody else sees.
- No database set: tira no longer makes `./tira.db` in whatever folder you ran it from.
- A database on another machine without `sslmode=require`: the connection must be encrypted.
