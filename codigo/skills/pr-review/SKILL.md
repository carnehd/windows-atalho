---
name: pr-review
description: Looks for errors and for improvements in what a pull request changes, across code, data, API, configuration and tests
---

# Pull request review

You review one pull request of a service. Report what can go wrong (errors) and what would be better (improvements),
each at its file and line. Fewer findings you are sure of are worth more than many guesses.

## How to read it

1. Read the whole diff first, to see what the change is for.
2. Then open the files the change depends on: what calls the changed code, what it calls, its tests, its configuration.
3. Follow each change across the layers it touches: the API (controllers, the OpenAPI document), the logic, the data
   (entities, repositories, migrations), the configuration (application files, environment variables, compose and
   Kubernetes files), the tests, the documentation.
4. Check that what the title and the description of the pull request promise is what the code does.

## Errors

Report as an error what can give a wrong result, lose data, break at run time or let something in that should not:

- **Logic:** code that does not do what its name, its comment or its test says; a condition the wrong way round; an
  off-by-one; a case not handled (null, empty, missing, too big, a failure of something it calls).
- **Data:** a field added to an entity without its migration (Liquibase or Flyway), or a migration without the code
  that uses it; a migration that drops or narrows a column with data in it; a column added without a default for the
  rows already there; a changeset edited after it was released.
- **API:** a field removed or renamed, a status code or an error shape changed, without the OpenAPI document and the
  clients following; input not validated; an error that leaks internals to the caller.
- **Transactions and concurrency:** a write across two steps that can be left half done; state shared between
  requests; a retry that repeats a side effect.
- **Security:** a password, a token, a key or a private address written in code or configuration; sensitive data
  written to the log; SQL or commands built from input by hand; an endpoint that lost its authorization check.
- **Configuration:** a property read in code that no environment defines; a variable named one way in the
  application file and another in compose or Kubernetes; a secret read from the wrong place.
- **Tests:** a test weakened or deleted to make the change pass; new behaviour with no test at all.
- **Resources:** a stream, a connection or a client not closed; an HTTP call with no timeout.

## Improvements

Report as an improvement what works but would be better otherwise:

- the same code written twice, or code harder to read than it needs to be;
- a name, a message or a comment that says something else than the code does;
- a log line that will not help when things go wrong (wrong level, no context), or too noisy;
- something simpler that the language, the framework or the project already has;
- a missing test for a case the change adds, or a test that checks less than it could;
- a convention of the project (see below) not followed.

## What to leave out

- style that a formatter decides: spaces, line length, the order of imports;
- praise, and remarks about code the pull request does not touch, unless the change breaks it;
- anything you did not verify by reading the code.

## Wording

- The summary: two to four bullet points, one per line, each starting with "- ": what the pull request does, then
  what stands out in it.
- One finding per problem, at the line where it is clearest: the title says what is wrong in one sentence, the detail
  says why it matters and what would fix it, the suggestion has the code when the fix is obvious.
- Write in English, plainly.

## Conventions of the project (change this part for your team)

- Stack: Java 21, Spring Boot 3, Maven, PostgreSQL with Liquibase migrations; one database schema per service, a
  DDL user for migrations and a DML user for the application.
- Each environment has its own values (dev, sit, uat, prod): configuration comes from environment variables or
  secrets, never from values written in the code.
- REST APIs are described in an OpenAPI document kept in the repository; it changes with the API.
- API tests are Bruno collections in the repository; a new endpoint gets its requests.
- Deployment is compose locally and Helm charts (k8s/) elsewhere; a new variable or secret is added to both.
