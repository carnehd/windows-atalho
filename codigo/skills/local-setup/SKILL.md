---
name: local-setup
purpose: local-setup
description: Finds what a microservice needs running on this computer (database, cache, messaging, identity...), how to start each one, and what it takes to build and start the microservice itself. QuickDeck writes the answer as recipe files
---

# What a microservice needs to run on this computer

You read one microservice and say what has to be running on this computer for it to start and to do its work: a
database, a cache, a message broker, an identity server, another service. QuickDeck shows your list to the user, and
starts what the user chooses from what you say here: you do not start anything.

QuickDeck also writes your answer as **recipes**: one file for the microservice and one for each service it needs
(postgres, redis, pubsub...). An assistant, or a person, follows them later to start everything without reading the
code again. So be exact: the commands, ports, names and values you give are the ones that will be run, and nobody
will check them against the repository.

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

## The microservice itself

Besides what it needs, say what it takes to build it and start it here (the **microservice** part of the answer):

- **buildTool:** maven or gradle (other when it is neither). **wrapper:** true when the folder has mvnw or gradlew.
- **java:** the version it is built with (java.version, the compiler release, the toolchain).
- **jar:** the runnable jar the build makes, from the microservice folder, as the build names it:
  target/ARTIFACTID-VERSION.jar (mind finalName and the version of the pom), or the bootJar in build/libs. Empty when
  the build makes no runnable jar.
- **port:** the port it listens on when nothing changes it (server.port in its files, else 8080). **managementPort:**
  only when the actuator has a port of its own.
- **healthPath:** the address that says it is up (/actuator/health when the actuator is there). Empty when there is none.
- **profile:** the Spring profile for local work (application-local.yml and the like). Empty when there is none.
- **variables:** what it has to be given to start here, besides the variables of what it needs: those with no default,
  and those whose default does not work on this computer, such as the address of another microservice.
  Leave out SERVER_PORT and the profile: the recipe sets them.
- **notes:** what else to know to start it, in short sentences (6 at most): an order, a flag, what usually fails.

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
- **ready:** a command inside the container that succeeds only when it is ready for work. It has to work in any container
  of that image, even one that somebody else started: an assistant uses it to tell whether a service that already runs is
  the same kind of thing, and to reuse it.
- **steps:** the commands inside the container that leave it as the microservice expects (topics, realm, clients).
  They run once, after ready, one after the other, as a list of words with no shell around them; use
  ["sh", "-c", "..."] when you need one. A step that fails stops the rest, so make them fail only for a real problem.
  **Steps must be safe to run again**: a service that was running already is reused, and the steps run on it too. When
  the thing may exist (a topic, a realm, a client, a user), the step must succeed then as well: test first, or accept
  the answer "exists already".
- **byHand:** what a person has to do themself, in short imperative sentences. For another microservice, say which
  repository and how to start it. For an external system with no image, say what is needed from the team that has it.
  The recipes keep this for the person who starts things by hand: an assistant does not follow it.

The **id** names the recipe file, and many microservices share a service: use the usual short name for the same thing
every time (postgres, redis, pubsub, keycloak, kafka, rabbitmq, mongodb, mailhog), not a name of your own. Another
microservice (kind service) has no container here: it is always started new, by its own recipe, never reused. Say in
byHand which repository it is.

Values: use what the configuration has for local work. Where there is none, make up a plain one for local work only,
such as local-orders-password. Never use a value that belongs to another environment (dev, test, production), and
never repeat a real credential you find: say in byHand that it should be replaced.

## What is known to work

### PostgreSQL

Image docker.io/library/postgres:16-alpine (or the version compose has), with the variable POSTGRES_PASSWORD=postgres, ready
["pg_isready", "-U", "postgres"]. Do not create the database with variables or steps: fill in **database** (its name,
schema, the user that makes the tables and the user of the application, with their passwords, and the migrations it
uses), and QuickDeck creates all of them. When the microservice uses one user only, give it as the DDL user and give
the DML user another name. Without a schema in the configuration, use public.

### Redis

Image docker.io/library/redis:7-alpine, ready ["redis-cli", "ping"]. Nothing else to create.

### Google Pub/Sub

The emulator: image gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators, command
["gcloud", "beta", "emulators", "pubsub", "start", "--project=PROJECT", "--host-port=0.0.0.0:8085"], ready
["curl", "-sf", "http://localhost:8085/"].

The emulator starts empty and forgets everything when it stops. Add one step per topic, and one per subscription. Both
accept "exists already" (409), so they can run again on an emulator that is running:

- ["sh", "-c", "c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT http://localhost:8085/v1/projects/PROJECT/topics/TOPIC); [ \"$c\" = 200 ] || [ \"$c\" = 409 ]"]
- ["sh", "-c", "c=$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'Content-Type: application/json' -d '{\"topic\":\"projects/PROJECT/topics/TOPIC\"}' http://localhost:8085/v1/projects/PROJECT/subscriptions/SUBSCRIPTION); [ \"$c\" = 200 ] || [ \"$c\" = 409 ]"]

A subscription needs its topic even when another microservice is the one that publishes to it: create that topic too,
with a name that fits, and say so in settings. Without PUBSUB_EMULATOR_HOST or spring.cloud.gcp.pubsub.emulator-host,
the client goes to the real Google Cloud: say that as a variable.

### Keycloak

Image quay.io/keycloak/keycloak:26.7.4, command ["start-dev"], variables KC_BOOTSTRAP_ADMIN_USERNAME=admin and
KC_BOOTSTRAP_ADMIN_PASSWORD=admin; it listens on 8080 inside, so publish the port of the configuration onto 8080. Ready:

["/opt/keycloak/bin/kcadm.sh", "config", "credentials", "--server", "http://localhost:8080", "--realm", "master", "--user", "admin", "--password", "admin"]

Once that worked, the same kcadm.sh works without credentials in the steps. The image has no curl. Steps, for what the
code uses; each one tests first, so it can run again on a Keycloak that is running (kcadm.sh is /opt/keycloak/bin/kcadm.sh):

- the realm: ["sh", "-c", "K=/opt/keycloak/bin/kcadm.sh; $K get realms/REALM >/dev/null 2>&1 || $K create realms -s realm=REALM -s enabled=true"]
- a client with a secret: ["sh", "-c", "K=/opt/keycloak/bin/kcadm.sh; [ -n \"$($K get clients -r REALM -q clientId=CLIENT --fields id --format csv --noquotes)\" ] || $K create clients -r REALM -s clientId=CLIENT -s secret=SECRET -s serviceAccountsEnabled=true -s publicClient=false -s directAccessGrantsEnabled=true"]
- a role of its service account, when the code calls the Admin API: ["/opt/keycloak/bin/kcadm.sh", "add-roles", "-r", "REALM", "--uusername", "service-account-CLIENT", "--cclientid", "realm-management", "--rolename", "view-users"]
- a user to try it with: ["sh", "-c", "K=/opt/keycloak/bin/kcadm.sh; [ -n \"$($K get users -r REALM -q username=demo --fields id --format csv --noquotes)\" ] || $K create users -r REALM -s username=demo -s enabled=true -s email=demo@example.com -s firstName=Demo -s lastName=User -s emailVerified=true"], then ["/opt/keycloak/bin/kcadm.sh", "set-password", "-r", "REALM", "--username", "demo", "--new-password", "demo"]

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
