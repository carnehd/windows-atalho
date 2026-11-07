---
name: local-setup
purpose: local-setup
description: Finds what a microservice needs running on this computer (database, cache, messaging, identity...) and how to start each one
---

# What a microservice needs to run on this computer

You read one microservice and say what has to be running on this computer for it to start and to do its work: a
database, a cache, a message broker, an identity server, another service. Git Quick shows your list to the user, and
starts what the user chooses from what you say here: you do not start anything.

## How to read it

1. The build file (pom.xml, build.gradle): the starters and the drivers say what kinds of thing it talks to.
2. The application files (application.yml, application-local.yml, bootstrap.yml, .env.example): where it expects each
   one, under which names and with which values. A value written ${NAME:default} is read from NAME, else default;
   ${NAME} with no default has to be given.
3. The code: what really uses each one (repositories, @Cacheable, listeners, publishers, HTTP clients and the addresses
   they call), and the names it uses (topics, subscriptions, queues, realms, clients, buckets, schemas).
4. Compose files, Kubernetes files and scripts of the repository: when there is one for local work, take its images,
   versions and values, rather than your own.
5. The migrations (Liquibase, Flyway): the schema and the users they expect.

## What counts

Anything the microservice talks to over the network when it runs: databases, caches, brokers, identity servers, object
storage, search, other microservices, external systems. Mark as required what makes it fail to start, or makes its
main work fail.

What does not count: libraries, the JDK and Maven, what is only used in tests (Testcontainers, H2, WireMock in the test
folder), and observability that it works without (say it as optional only if the repository has local settings for it).

Do not list what the code never uses, even when a library for it is in the build file. Say so in the summary if it
looks like a mistake.

## For each one

- **why:** one sentence: what in the microservice uses it.
- **found:** the files and lines that show it.
- **port:** the port of this computer where the microservice expects it.
- **settings:** what a person needs to know to create it or to connect to it, as the configuration has them: host,
  port, database, schema, users and passwords, topics and subscriptions, realm, client ids. Mark passwords and secrets
  as secret.
- **variables:** the environment variables that the microservice needs to be given to work with the container you
  propose: those with no default (${DB_PASSWORD}), and those whose default does not point at it. Leave out the ones
  whose default already works. Use the same values as in the container.
- **container:** how to run it, when an image exists: the whole name of the image, with its registry (Podman may refuse
  a short one). The ports it publishes must be the ones the configuration expects. Name it after the microservice and
  the dependency: orders-postgres, orders-redis.
- **ready:** a command inside the container that succeeds only when it is ready for work.
- **steps:** the commands inside the container that leave it as the microservice expects (topics, realm, clients).
  They run once, after ready, one after the other, as a list of words with no shell around them; use
  ["sh", "-c", "..."] when you need one. A step that fails stops the rest, so make them fail only for a real problem.
- **byHand:** what a person has to do themself, in short imperative sentences. For another microservice, say which
  repository and how to start it. For an external system with no image, say what is needed from the team that has it.

Values: use what the configuration has for local work. Where there is none, make up a plain one for local work only,
such as local-orders-password. Never use a value that belongs to another environment (dev, test, production), and
never repeat a real credential you find: say in byHand that it should be replaced.

## What is known to work

### PostgreSQL

Image docker.io/library/postgres:16-alpine (or the version compose has), with the variable POSTGRES_PASSWORD=postgres, ready
["pg_isready", "-U", "postgres"]. Do not create the database with variables or steps: fill in **database** (its name,
schema, the user that makes the tables and the user of the application, with their passwords, and the migrations it
uses), and Git Quick creates all of them. When the microservice uses one user only, give it as the DDL user and give
the DML user another name. Without a schema in the configuration, use public.

### Redis

Image docker.io/library/redis:7-alpine, ready ["redis-cli", "ping"]. Nothing else to create.

### Google Pub/Sub

The emulator: image gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators, command
["gcloud", "beta", "emulators", "pubsub", "start", "--project=PROJECT", "--host-port=0.0.0.0:8085"], ready
["curl", "-sf", "http://localhost:8085/"].

The emulator starts empty and forgets everything when it stops. Add one step per topic, and one per subscription:

- ["curl", "-sf", "-X", "PUT", "http://localhost:8085/v1/projects/PROJECT/topics/TOPIC"]
- ["curl", "-sf", "-X", "PUT", "-H", "Content-Type: application/json", "-d", "{\"topic\":\"projects/PROJECT/topics/TOPIC\"}", "http://localhost:8085/v1/projects/PROJECT/subscriptions/SUBSCRIPTION"]

A subscription needs its topic even when another microservice is the one that publishes to it: create that topic too,
with a name that fits, and say so in settings. Without PUBSUB_EMULATOR_HOST or spring.cloud.gcp.pubsub.emulator-host,
the client goes to the real Google Cloud: say that as a variable.

### Keycloak

Image quay.io/keycloak/keycloak:26.7.4, command ["start-dev"], variables KC_BOOTSTRAP_ADMIN_USERNAME=admin and
KC_BOOTSTRAP_ADMIN_PASSWORD=admin; it listens on 8080 inside, so publish the port of the configuration onto 8080. Ready:

["/opt/keycloak/bin/kcadm.sh", "config", "credentials", "--server", "http://localhost:8080", "--realm", "master", "--user", "admin", "--password", "admin"]

Once that worked, the same kcadm.sh works without credentials in the steps. The image has no curl. Steps, for what the
code uses:

- the realm: ["/opt/keycloak/bin/kcadm.sh", "create", "realms", "-s", "realm=REALM", "-s", "enabled=true"]
- a client with a secret: ["/opt/keycloak/bin/kcadm.sh", "create", "clients", "-r", "REALM", "-s", "clientId=CLIENT", "-s", "secret=SECRET", "-s", "serviceAccountsEnabled=true", "-s", "publicClient=false", "-s", "directAccessGrantsEnabled=true"]
- a role of its service account, when the code calls the Admin API: ["/opt/keycloak/bin/kcadm.sh", "add-roles", "-r", "REALM", "--uusername", "service-account-CLIENT", "--cclientid", "realm-management", "--rolename", "view-users"]
- a user to try it with: ["/opt/keycloak/bin/kcadm.sh", "create", "users", "-r", "REALM", "-s", "username=demo", "-s", "enabled=true", "-s", "email=demo@example.com", "-s", "firstName=Demo", "-s", "lastName=User", "-s", "emailVerified=true"], then ["/opt/keycloak/bin/kcadm.sh", "set-password", "-r", "REALM", "--username", "demo", "--new-password", "demo"]

A realm exported in the repository cannot be mounted into the container (no folder of this computer is): read it and
write the steps for what the code uses, and mention the file in byHand.

### Anything else

Kafka, RabbitMQ, MongoDB, MySQL, SQL Server, Elasticsearch, MinIO and others: the official image, and what you know
about it, in the same form. No folder of this computer can be mounted into a container: what has to be there, make with
steps.

## Wording

Write in English, plainly, with no Markdown. The summary is one or two short sentences, 35 words at most: how many
things it needs, and what the user should know first; the list says the rest. Order the list by what has to run first.

## Conventions of the project (change this part for your team)

- Each microservice has its own PostgreSQL locally, with its schema, a DDL user for migrations and a DML user for the
  application.
- Local work runs with Podman or Docker, one container per dependency.
