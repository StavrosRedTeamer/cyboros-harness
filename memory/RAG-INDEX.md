# RAG index — soluzioni cristallizzate (grep-first)

> Rigenerato da `tools/memory-rag.js` ad ogni mutazione. Non editare a mano.
> Recupero per similarità: `node tools/memory-rag.js recall "<stack+ostacolo>"`. Voci retired escluse.

## AUTHZ (1)
- RAG-0002 [Next.js App Router, Vercel] Confronta la route protetta con e senza header interno x-middleware-subrequest e con una seconda identita: se 

## CACHE-POISON (2)
- RAG-0003 [Next.js, image optimizer, CDN] Due identita e due marker: se B riceve il marker di A e cache-key confusion. Con URL locali canary controlla a
- RAG-0017 [Varnish, Cloudflare, reverse proxy] Header non chiavati con marker benigno, poi una seconda sessione senza credenziali: la persistenza verso altri

## CORS (1)
- RAG-0013 [API con CORS riflesso] Origin riflesso piu Allow-Credentials true e critico; la conferma e leggere una risposta autenticata da un ori

## CSPT (1)
- RAG-0014 [SPA React, service worker] Trova la concatenazione source-sink nel bundle, poi --vary con ../ e %2e%2e/: la prova e un endpoint diverso c

## DATA-API (2)
- RAG-0004 [Supabase, PostgREST, PostgreSQL] Verifica i GRANT oltre alle policy: una policy non revoca un grant. Prova viste senza security_invoker, risors
- RAG-0005 [Firebase Realtime Database] Deduci le regole dal comportamento: shallow=true, un path canary, poi una seconda identita. Lettura cross-tena

## GRAPHQL (1)
- RAG-0016 [Apollo Server, GraphQL] Se introspection e aperta e gia un finding; altrimenti ricostruisci lo schema dal bundle e prova BOLA sui camp

## INJECTION (2)
- RAG-0007 [Spring SpEL, Struts OGNL] Probe con ${7*7}, #{7*7} e %{7*7}: il 49 renderizzato conferma. Anche l errore del parser (SpelEvaluationExcep
- RAG-0008 [Java, Log4j 2.x, JDK 17] Marker OOB sul nostro listener dentro un payload jndi in header che finiscono nei log; un hit DNS prova l inte

## JWT (1)
- RAG-0012 [API con JWT RS256] Prova alg:none, HS256 usando la chiave pubblica come segreto e jku/x5u verso un JWKS nostro; ogni tentativo va

## LFI (1)
- RAG-0009 [PHP 8, Apache] Usa php://filter per leggere una risorsa senza eseguirla; se l output e filtrato passa a una tecnica di inclus

## MCP (1)
- RAG-0015 [Server MCP, JSON-RPC] tools/list, resources/read e tools/call in sola lettura: l enumerazione e la prova. I tool che fetchano URL si

## NOSQLI (1)
- RAG-0011 [MongoDB, Express] Prova operatori $ne e $gt nel body e nei parametri annidati; un bypass di autenticazione e exploited solo quan

## PROTO-POLLUTION (1)
- RAG-0010 [Node.js, Express, lodash] Inietta __proto__ e constructor.prototype nel JSON e cerca un effetto deterministico in un oggetto di configur

## RACE (1)
- RAG-0018 [API REST, coupon e transfer] repeater --race 8 su endpoint che dovrebbero accettare una sola operazione: piu 2xx di quanti attesi e la prov

## SQLI (1)
- RAG-0001 [Nginx, Spring Boot, ModSecurity] Spezza la keyword con commenti inline e URL-encoding, poi conferma con boolean/time blind su un parametro nume

## SSTI (1)
- RAG-0006 [Jinja2, Twig, Freemarker, Velocity] Prima un errore di sintassi per il fingerprint del motore, poi un marker matematico (7*7 -> 49) nel rendering:

