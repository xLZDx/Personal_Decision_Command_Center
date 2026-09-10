# Adversarial Review #2 — Personal Decision OS TDD v0.2

**Дата:** 2026-09-10
**Контекст ревью:** свежая сессия относительно имплементации (имплементация ещё не начиналась). Оговорка честности, как требует промпт: ролевые проходы ARCH/SEC/PRIV/DATA/REL/AI/QA/UX/GOV/RED выполнены последовательно в одном контексте — это один ревьюер в десяти ролях, не десять независимых ревьюеров. Финальное закрытие гейтов должно включать проход вне этого контекста (GPT-PM/оператор/другая модель), что TDD §57(10) уже требует.
**Живая верификация выполнена в этой сессии:** Telegram API Terms + Content Licensing (прямой fetch), D1 hard-enforcement (changelog 01.09.2026), Queues Free (changelog 04.02.2026: 10K опер./день, retention 24ч), Workers Free CPU-лимиты (официальная таблица), Cloudflare Tunnel (все планы), iOS 16.4+ Web Push, Gmail watch/history (док. Google). Analytics Engine Free — подтвердить не удалось (см. NM-примечание).

---

## VERDICT

**BLOCK** — один новый BLOCKER фактического характера (NB1). По правилам §60 (≥1 BLOCKER → REJECT) иначе нельзя. Всё остальное в v0.2 — существенный и добросовестный прогресс; ожидаемый цикл до v0.3 — короткий.

---

## PREVIOUS FINDING CLOSURE MATRIX

| Finding | Статус | Доказательство |
|---|---|---|
| B1 scope | **CLOSED** | Gmail+Telegram зафиксированы везде: §3 scope lock, INV-02, §55 (нет outlook/slack директорий), §78, §79 (двухисточниковый сценарий), §80 (пересчитанные метрики), §82 («both source types»). Остатков 4-источникового текста не найдено. |
| B2 taint | **PARTIAL** | Value-level DAG (§7), datatype-независимость, автоматические policy-тесты (§70) — правильное и сильное закрытие основного канала. Остался шов: enum/агрегатный/экзистенциальный канал — см. NM2. Сам §7 внутренне противоречив по intent_class. |
| B3 push | **CLOSED** | §32: payload = {type, notification_id, schema_version}; явный запрет sender/title/question/deadline; generic локальный текст; DoD §75 «push payload inspected and proven opaque». Остаточный timing side-channel (FCM/APNs видит факт и время события) — неустраним для любого push, классифицирован INFO. |
| B4 tunnel | **CLOSED (plan-level)** | §10.3 Cloudflare Tunnel + ADR-007, outbound-only; §33 путь drill-down; resilience-тест «Tunnel unavailable». Условие: ADR-007 обязан содержать полную цепочку аутентификации (PWA-сессия → Worker → service token → cloudflared → локальная проверка gateway) — сейчас она подразумевается, но не специфицирована (MIN-4). По §33.1 см. рекомендацию в SECURITY VERDICT. |
| M1 mautrix | **CLOSED** | Direct TDLib (§11, ADR-003), Matrix явно в non-goals (§4), нет matrix-директорий. |
| M2 gap-recovery | **CLOSED** | §12.1: PRE_CONNECTION_BACKFILL=OFF vs POST_CONNECTION_GAP_RECOVERY=REQUIRED, граница connected_at, messages.list только для известного окна, DoD §69. Это ровно та развязка, которой не хватало. |
| M3 D1/метрики | **CLOSED** (с оговоркой) | §36: D1=состояние, AE=телеметрия, «not unlimited» — корректно. Числа AE (100K dp/день, 10K запросов/день) в этой сессии независимо подтвердить не удалось — оставить как «re-verify at G2», что TDD и предписывает. |
| M4 CPU queue-consumer | **REOPENED → NB1** | «Коррекция коррекции» сама оказалась фактически неточной для Free-плана. См. NB1. |
| M5 queue expiry | **CLOSED** | INV-10 + Processing Reconciler (§17), независимый от статуса outbox DISPATCHED; обязательный resilience-кейс; «no logical duplicates» тестируется. Дополнение NM4 (poison-loop) — ниже. |
| M6 iOS push DoD | **CLOSED** | §75: функциональный тест на реальном устройстве, sync-on-open, явный отказ от выдуманного SLA — соответствует и платформе, и требованию промпта. |
| M7 governance | **PARTIAL** | §57: protected main, operator-held credentials, path enforcement, test-deletion guard, fresh-context review — закрыто. Дыра: целостность самого gate-manifest — см. NM3. |
| M8 Workers AI terms | **CLOSED (conditional)** | §25 корректно передаёт документированную позицию Cloudflare (Customer Content не используется для обучения без явного согласия); снапшот условий и лицензии модели остаётся обязанностью G0/ADR-009 — правильно. |
| M9 namespacing | **CLOSED** | §20 ERP::Gate-4.2, naked ID не глобален, INV-16 hard barrier, DoD §72 «cross-project auto-merge impossible», 10 collision-кейсов в §80. Атака повторена: без подтверждённого проекта вес +0.35 недостижим (идентификатор не может быть namespaced), максимум сигналов без проекта/стрима = 0.15 → SEPARATE. Подтверждаю механическую невозможность. |
| M10 метрики 2 источников | **CLOSED** | §80 полностью пересчитан, включая ambiguous/no-merge и collision-кейсы, рубрика до финального прогона. |

---

## NEW BLOCKERS

**NB1 — Архитектурная посылка §16 о CPU queue-consumer неверна для Workers Free.**
§16/§65 утверждают: «Queue consumer default CPU 30s, configurable up to 5m» без квалификации плана, и на этом строят решение «resolution work runs in the queue consumer». Официальная таблица лимитов Workers говорит: **Workers Free = 10 ms CPU на инвокацию** (и для HTTP, и для Cron); «default 30s / до 5 минут через limits.cpu_ms» — это описание **Paid-плана** (документация Cloudflare прямо: «On the Workers Paid plan, you can raise the limit from the default 30 seconds up to 5 minutes»). Страница лимитов Queues говорит, что consumers «share the same per invocation CPU limits as any Workers do» — на Free это ~10 ms, а не 30 s. В HARD_ZERO-архитектуре импортирован Paid-план-факт. (Отдельно и честно: review-of-review поправлял v0.1-ревью в противоположную сторону — и эта поправка сама небезупречна: моя v0.1-претензия «10ms применимо к пайплайну» для Free-плана была по существу верной.)

Последствия и требуемые исправления в v0.3:
1. §65 факт-таблица: CPU consumer на Free = как у обычного Worker (~10 ms); 30s/5m — Paid.
2. §16: посылка «consumer = тяжёлая работа» заменяется на «consumer = такой же лёгкий, как ingress»: маленькие батчи (max_batch_size невысокий), I/O-доминантная обработка (ожидание D1 не тратит CPU), чистый CPU на событие (скоринг нескольких кандидатов, schema-валидация, HMAC) держится в единицах миллисекунд. Это почти наверняка достижимо для одного пользователя, но обязано быть **измерено**: в G2 quota-harness добавить CPU-профилирование consumer-инвокации; empirical smoke-тест реального лимита на Free-аккаунте (тривиальный consumer с контролируемой CPU-нагрузкой) — дешёвый и окончательный.
3. §53 бэкап: «compress → encrypt» мегабайтных чанков в Worker на 10 ms CPU нереалистичен. Перенести исполнение бэкапа на connector host (полноценный Linux без CPU-лимитов): host по расписанию тянет чанкованный экспорт через API и сам делает compress+encrypt+upload в R2. Это одновременно упрощает и key-management (ключ бэкапа не живёт в Workers).

---

## NEW MAJORS

**NM2 — Enum/агрегатный/экзистенциальный канал утечки в AI (шов B2; вопрос промпта Q6).**
§7 внутренне противоречив: intent_class объявлен «system-owned constant», но со скобкой «the assignment itself carries evidence provenance». INV-05 говорит «every content-derived value». Является ли `intent_class=DECISION_REQUIRED`, присвоенный правилом из Telegram-текста, content-derived значением? Если AI-контекст для Gmail-evidence включает поля topic-уровня (state, intent_class, updated_at, счётчики, состав участников), информация из Telegram просачивается: (а) enum-присвоение, вызванное Telegram-сообщением, — это ≥1 бит Telegram-происхождения; (б) `updated_at`/`occurred_at`, продвинутые Telegram-событием, — Telegram-derived datetime; (в) сам состав топика (какие Gmail-письма оказались рядом) сформирован Telegram-событиями — экзистенциальная утечка через селекцию контекста. Требование к v0.3 — выбрать и записать одно из двух, явно:
- **Вариант A (рекомендую):** правило «AI-контекст состоит исключительно из Gmail-evidence-scoped объектов; никаких полей topic/stream/person-уровня и никаких агрегатов» — тогда (а) и (б) исчезают конструктивно, а (в) остаётся единственной, документированной как принятая bounded-утечка (membership-selection не реконструирует контент).
- **Вариант B:** enum/state/датовые поля с Telegram-provenance допускаются в контекст как принятая ограниченная утечка — тогда это прямо документируется с обоснованием, и INV-05 корректируется, чтобы не противоречить практике.
Молчаливое «как получится» недопустимо: сейчас автоматический тест §70 не поймает вариант (в) и, в зависимости от реализации wrapper'ов, может не поймать (а)/(б).

**NM3 — Целостность gate-manifest не защищена от имплементера.**
§57(5) требует «signed/hashed gate-manifest.yaml», но: кем подписан? Манифесты лежат в repo (`governance/gate-manifests/`), а список policy-sensitive файлов §57(9) их **не включает**. Если Claude может править манифест в своей ветке, то path-enforcement CI проверяет изменения против документа, который меняется тем же актором — самореферентная защита. Исправление: (а) gate-manifests добавить в policy-sensitive paths; (б) манифест попадает в protected main только коммитом оператора; (в) CI сверяет хэш манифеста с операторски зафиксированным значением (например, значение хэша хранится в защищённой ветке/CI-переменной, недоступной ветке имплементера).

**NM4 — Reconciler poison-loop.**
§17: reconciler re-enqueues «ACCEPTED + old + not PROCESSED». Событие в состоянии FAILED/DLQ формально «not PROCESSED» — без явного исключения FAILED и потолка попыток реконсилер будет вечно перезаряжать ядовитое событие (и жечь Queue-операции из бюджета 10K/день). Требование: reconciler исключает FAILED/DLQ; общий attempt-cap событие→DLQ; resilience-тест «poison event не зацикливается и уходит в DLQ за ≤N попыток».

---

## MINORS

1. `routing_hints` в контракте §13 — голый массив; если туда попадают извлечённые идентификаторы (ERP::Gate-4.2 из Telegram-текста), они обязаны быть provenance-wrapped как любой DerivedValue.
2. TDLib при первом логине синхронизирует диалоги и часть недавней истории в свой локальный кэш — это нормальное клиентское поведение, но §11 должен явно провести границу: «запрещена центральная эмиссия событий с occurred_at < connected_at; локальный TDLib-кэш — client-normal и остаётся на хосте».
3. Cloudflare Access внутри standalone-PWA на iOS — известная точка трения (redirect-флоу IdP в режиме Home Screen). Добавить в G7 явный тест логина/ре-логина Access именно в standalone-режиме iOS, не только в Safari.
4. ADR-007: включить диаграмму полной auth-цепочки content gateway (см. closure B4).
5. Analytics Engine Free-лимиты: числа TDD в этой сессии не подтверждены независимым источником — G2 обязан зафиксировать актуальные значения из живой страницы прайсинга (TDD сам это предписывает; фиксирую как открытую верификацию, не как ошибку).
6. Timestamp-провенанс: «parsed relative date is provenance-bearing» (§63) — хорошо; расширить формулировку на occurred_at/received_at Telegram-событий, когда они используются в проекциях/объяснениях (при принятии NM2-варианта A вопрос почти закрывается сам).
7. Push timing side-channel — INFO: FCM/APNs видит факт и момент активности; неустранимо, задокументировать как принятый остаточный риск в THREAT_MODEL.

---

## TELEGRAM / PROVENANCE VERDICT

Позиция §6 корректна и соответствует живому тексту условий (перепроверено fetch'ем в этой сессии): детерминированный приём/отображение/drill-down — допустимый дизайн-путь; любые Telegram-значения в AI — запрещены; realtime не создаёт исключения из AI-пункта; кросс-канальное операционное использование Telegram-метаданных остаётся YELLOW/UNCLEAR (R1 честно это фиксирует). Value-level DAG — правильный механизм; после закрытия NM2 (вариант A) я не вижу оставшегося канала, через который Telegram-контент восстановим из AI-контекста: экзистенциальная membership-утечка остаётся, ограничена и не реконструирует текст. Ответ на Q4 промпта: да, Gmail+Telegram → один топик работает без Telegram→AI утечки при варианте A и детерминированной связке через namespaced ID/подтверждённого участника; потолок recall (§22.1) — честно принятый компромисс.

## GMAIL VERDICT

Дизайн зрелый: watch с ежедневным renewal, OIDC/JWT-проверка Pub/Sub push, разделение backfill/gap-recovery с границей connected_at, poll-fallback как явный режим для HARD_ZERO при требовании billing-аккаунта (R4). DoD §69 покрывает 404-курсор и дедуп восстановления. Замечаний уровня MAJOR нет. G3-проверка billing-требования GCP остаётся обязательной.

## RELIABILITY / QUEUE VERDICT

Цепочка spool → durable ingest → outbox → queue → idempotent consumer → reconciler закрывает все перечисленные промптом сценарии потери, кроме честно задекларированного residual-риска (гибель диска хоста до ACK — §15, задокументировано; TDLib-difference recovery смягчает). Разграничение «accepted durability / source recoverability / push delivery / content availability» проведено (§32, §81: push не является correctness-состоянием). Два дополнения: NM4 (poison-loop) и NB1-следствие (лёгкие consumer-инвокации, маленькие батчи). После них reliability-контур считаю добротным для personal-MVP.

## SECURITY VERDICT

Модель угроз полна; ключевые контроли (PKCE, шифрование refresh-токенов с ключом вне D1, HMAC/mTLS с ротацией и runbook компрометации, opaque push, запрет raw-контента в 9 категориях включая CI-fixtures, hash-chained audit, plain-text рендер AI-полей) — на уровне. По §33.1 (E2E-шифрование Telegram drill-down): рекомендую **вариант A как условие**, не блокер — WebCrypto ECDH+HKDF+AES-GCM это малый объём кода, а устраняет самую крупную экспозицию сырого Telegram-текста промежуточной инфраструктуре; если G0 выберет B (TLS+Access), это допустимо для персонального MVP только как явно записанный принятый риск — «no silent downgrade» в TDD уже сформулирован правильно. Prompt-injection контур (§44) корректен: без инструментов, без кредов, schema-валидация, длина/plain-text.

## PWA / PUSH VERDICT

Реалистично: opaque push, sync-on-open как источник истины, функциональные тесты на реальных устройствах, отказ от выдуманного SLA. iOS-риски: 16.4+ требование учтено; добавить MIN-3 (Access в standalone) в G7. Drill-down реализуем на всех трёх таргетах при закрытом B4/ADR-007.

## DATA / FREE-TIER COST VERDICT

Расчёт per-event (запрошен промптом), консервативно: D1 writes ≈ 5–8/событие (ingest + outbox insert/update + topic_event + intent/decision изредка + audit) → 200 соб./день ≈ 1–1.6K writes; 1000 соб./день ≈ 5–8K — при лимите 100K/день запас >10×. D1 reads ≈ 30–80/событие при индексированных lookup'ах (dedupe, кандидаты-топики, mappings) → 1000 соб./день ≈ 80K + периодика reconciler + чанкованный экспорт (~общий размер стейта) — при 5M/день запас огромный, **при условии** индексов и отсутствия сканов (уже мандатно, §35). Queue ops ≈ 3/событие → 1000 соб./день ≈ 3K из 10K — **первый потолок всей системы ≈ 3.3K событий/день**; для одного пользователя недостижимо в норме, но шторм (массовая рассылка/флуд-чат) должен деградировать: добавить в §16 producer-side защиту (rate-cap/coalescing при приближении к дневному лимиту, деградация в reconciler-driven обработку). Workers requests: сотни/день « 100K. AE: при 5–10 dp/событие — в пределах заявленного лимита, сами числа перепроверить (MIN-5). Хранилище: metadata-only, 500MB/БД достаточно с запасом на годы при данной retention-политике. D1 остаётся разумным выбором MVP1. $0/мес: реалистичен на условиях §64 (owned host); формула честная.

## GOVERNANCE VERDICT

§56–§61 после v0.2 — рабочая механика, а не декларация: protected main, операторские креды, path/scope CI, test-deletion guard, fresh-context review, невозможность самопонижения severity. Единственная существенная дыра — NM3 (манифест правится тем, кого он ограничивает). С её закрытием ответ на все семь вопросов промпта («может ли Claude...») — нет, при условии, что оператор реально держит merge/deploy у себя.

## DoD VERDICT

DoD §67–§82 измеримы, бинарны и достижимы в утверждённом скоупе; §70 (policy-тесты по типам данных) — образцовый. Пробелы: четыре пункта из «DoD GAPS» v0.1-ревью закрыты (двухисточниковый exit, quota-тест, iOS-push операционализация, policy-тест вместо «ревью глазами», restore до закрытия). Новые требования к DoD из этого ревью: CPU-профиль consumer-инвокации в quota-harness (NB1), poison-loop тест (NM4), AI-context-scope тест по выбранному NM2-варианту, манифест-integrity проверка (NM3).

## REQUIRED TDD v0.3 CHANGES

1. §16, §53, §65 — исправление CPU-факта Free-плана, лёгкие consumer-инвокации + измерение, бэкап-исполнение на connector host (NB1).
2. §7/§24 — явное правило состава AI-контекста (NM2, рекомендован вариант A: Gmail-evidence-only), устранение противоречия про intent_class, документирование принятой membership-утечки.
3. §57 — gate-manifests в policy-sensitive paths + операторская фиксация хэша (NM3).
4. §17 — исключение FAILED/DLQ из reconciler + attempt-cap + тест (NM4).
5. §13 — provenance-wrapped routing_hints; §11 — граница TDLib-кэша (MIN-1, MIN-2).
6. §16 — producer-side деградация при приближении к Queue-лимиту (из cost-вердикта).
7. ADR-007 — auth-цепочка; G7 — Access-standalone-iOS тест; THREAT_MODEL — push-timing INFO.

## RECOMMENDED GATE ORDER CHANGES

Порядок G0–G10 (§83) сохранить. Три вставки: в G0 — empirical CPU-smoke на Free-аккаунте + решение §33.1 (A/B) + NM2-вариант; в G2 — CPU-профилирование consumer и фиксация живых AE-лимитов; в G8 — бэкап host-side (следствие NB1).

## FINAL GO / NO-GO

**NO-GO для v0.2 as-is** (NB1 + NM2–NM4). Все находки локальны и закрываемы правкой документа плюс одним дешёвым эмпирическим тестом; при v0.3, закрывающей их, ожидаемый вердикт — **GO WITH CONDITIONS** (условия: empirical CPU-подтверждение на G0/G2, явное решение по §33.1, живая верификация AE-лимитов и GCP-billing на соответствующих гейтах). Ядро v0.2 — value-level provenance DAG, opaque push, reconciler, разделение backfill/recovery, механическая невозможность cross-project merge, двухисточниковый DoD — оцениваю как готовое к имплементации после этих правок.
