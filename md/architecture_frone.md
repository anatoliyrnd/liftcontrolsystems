# Architecture: Lift Control Systems Frontend

## 1. Core Services & Infrastructure

### ApiService (`api-service.js`)

**Export:** `class ApiService`  
**Description:** Центральный HTTP-клиент с управлением авторизацией и тегами запросов.

- **Constructor:** `constructor(baseUrl?: string, options?: { local: boolean })`
- **Static Properties:**
  - `AUTH_LOST_EVENT: string`
- **Methods:**
  - `setToken(token: string): void`
  - `abortTag(tag: string): void`
  - `get(queryParams?: object, actionComment?: string, tag?: string): Promise<any>`
  - `post(body?: object, actionComment?: string, tag?: string): Promise<any>`
  - `login(name: string, password: string, autoLogin: boolean): Promise<any>`
  - `loginById(userId: number, password: string, autoLogin: boolean): Promise<any>`
  - `tryAutoLogin(): Promise<any>`
  - `logout(): Promise<any>`

**Dependencies:** `auth-store`, `config`

---

### OfflineDB (`offline-db.js`)

**Export:** `const offlineDB` (Singleton instance of `OfflineDB`)  
**Description:** Обертка над IndexedDB для офлайн-хранения заявок, адресов и очереди команд.

- **Config Methods:**
  - `setConfig(key: string, value: any): Promise<void>`
  - `getConfig(key: string): Promise<any>`
- **Address Methods:**
  - `saveAddresses(flatAddresses: Array): Promise<void>`
  - `getCities(): Promise<Array<{id, name}>>`
  - `searchAddresses(cityId: number, query: string): Promise<Array>`
- **Outbox Methods (New API):**
  - `addOutboxCommand(cmd: OutboxCommand): Promise<OutboxCommand>`
  - `getAllPending(): Promise<Array<OutboxCommand>>`
  - `getPendingBatch(limit?: number): Promise<Array<OutboxCommand>>`
  - `getPendingByTicket(ticketId: number|string): Promise<Array<OutboxCommand>>`
  - `getPendingByAuthor(authorId: number): Promise<Array<OutboxCommand>>`
  - `updateOutboxCommand(commandUuid: string, patch: object): Promise<OutboxCommand|null>`
  - `deleteOutboxCommands(uuids: string[]): Promise<void>`
  - `getOutboxCount(): Promise<number>`
  - `getFailedCount(): Promise<number>`
  - `countByType(type: string): Promise<number>`
  - `clearOutbox(): Promise<void>`
- **Outbox Shim Methods (Deprecated):**
  - `addToOutbox(oldCmd: object): Promise<object>`
  - `getOutboxBatch(limit?: number): Promise<Array>`
  - `getAllFromOutbox(): Promise<Array>`
  - `deleteFromOutbox(uuids: string[]): Promise<void>`
- **Tickets Cache Methods:**
  - `saveTickets(type: string, tickets: Array): Promise<void>`
  - `getTickets(type: string): Promise<Array>`

**Dependencies:** `vendor/idb`

---

### SyncManager (`sync-manager.js`)

**Export:** `class SyncManager`  
**Description:** Оркестратор фоновой синхронизации outbox-очереди с сервером.

- **Constructor:** `constructor(api: ApiService, router: object, onOpenTicketsUpdated: Function, opts?: { onDuplicateDetected?: Function })`
- **Public Properties:**
  - `isSyncing: boolean`
- **Methods:**
  - `start(): void`
  - `stop(): void`
  - `triggerSync(): Promise<void>`

**Dependencies:** `offline-db`, `auth-store`, `outbox-queue`, `sync/batch-builder`, `sync/backoff`, `utils/uuid`, `utils/sync-lock`, `components/notify`, `history-logger`, `api-service`

---

## 2. State Management Stores

### authStore (`auth-store.js`)

**Export:** `const authStore`  
**Description:** Хранилище сессии (access-token в памяти, user в localStorage).

- **Methods:**
  - `loadUser(): void`
  - `setSession(accessToken: string, expiresAt: number, user: object): void`
  - `setAccess(accessToken: string, expiresAt: number): void`
  - `clear(): void`
  - `getAccess(): string|null`
  - `getExpiresAt(): number|null`
  - `getUser(): object|null`
  - `hasAccess(): boolean`
  - `getRole(): string`

**Dependencies:** `config`

### userStore (`user-store.js`)

**Export:** `const userStore`  
**Description:** Хранилище роли и матрицы прав доступа.

- **Properties:**
  - `ROLES: string[]`
  - `role: string`
  - `userId: number|null`
  - `ROLES_EDIT: string[]`
- **Methods:**
  - `setUserId(id: number): void`
  - `setRole(newRole: string): void`
  - `isAdmin(): boolean`
  - `isDispatcher(): boolean`
  - `isEngineer(): boolean`
  - `isGuest(): boolean`
  - `canEditBase(): boolean`
  - `can(action: string, ctx?: object): boolean`
  - `isAssignedTo(ticket: object, currentUserId: number): boolean`

### dictStore (`dict-store.js`)

**Export:** `const dictStore`  
**Description:** Хранилище справочников (отдел, запрос, группа).

- **Properties:**
  - `department: Array`
  - `request: Array`
  - `group: Array`
- **Methods:**
  - `set(key: 'department'|'request'|'group', raw: Object|Array): void`
  - `getName(key: string, id: string|number): string|null`
  - `fillSelect(selectEl: HTMLSelectElement, key: string, placeholder?: string, selectedId?: string|number|null): void`

### staffStore (`staff-store.js`)

**Export:** `const staffStore`  
**Description:** Хранилище списка электромехаников.

- **Properties:**
  - `list: Array<{id, name, phone}>`
- **Methods:**
  - `setList(arr: Array): void`
  - `getById(id: string|number): object|null`
  - `getPhone(id: string|number): string|null`
  - `fillSelect(selectEl: HTMLSelectElement, placeholder?: string, selectedId?: string|number|null): void`

### appState (`app-state.js`)

**Export:** `const appState`  
**Description:** Глобальное состояние UI-контекста.

- **Properties:**
  - `pendingCreateAddress: object|null`
- **Methods:**
  - `reset(): void`

---

## 3. Controllers

### LoginController (`login-controller.js`)

**Export:** `class LoginController`

- **Constructor:** `constructor(apiInstance: ApiService, routerInstance: object)`
- **Methods:**
  - `mount(): Promise<void>`
  - `unmount(): void`

**Dependencies:** `auth-store`, `components/notify`, `history-logger`

### CreateController (`create-controller.js`)

**Export:** `class CreateController`

- **Constructor:** `constructor(apiInstance: ApiService, routerInstance: object)`
- **Methods:**
  - `mount(globalTicketsArrayRef: Array): void`
  - `unmount(): void`

**Dependencies:** `staff-store`, `components/*`, `history-logger`, `config`, `app-state`, `offline-db`, `auth-store`, `utils/date-utils`, `outbox-queue`

### TicketsController (`tickets-controller.js`)

**Export:** `class TicketsController`

- **Constructor:** `constructor(apiInstance: ApiService, routerInstance: object, dataType?: 'open'|'close')`
- **Methods:**
  - `mount(globalTicketsArrayRef: Array): Promise<void>`
  - `unmount(): void`
  - `refreshFromMemory(ticketsArrayRef: Array): void`

**Dependencies:** `table/*`, `config`, `history-logger`, `offline-db`, `utils/date-utils`

### DetailsController (`details-controller.js`)

**Export:** `class DetailsController`

- **Constructor:** `constructor(apiInstance: ApiService, routerInstance: object)`
- **Methods:**
  - `mount(ticketId: string|number, globalTicketsArrayRef: Array): Promise<void>`
  - `unmount(): void`

**Dependencies:** `auth-store`, `user-store`, `dict-store`, `staff-store`, `outbox-queue`, `app-state`, `offline-db`, `components/*`, `history-logger`, `config`, `utils/date-utils`

### QueueController (`queue-controller.js`)

**Export:** `class QueueController`

- **Constructor:** `constructor(api: ApiService, router: object)`
- **Methods:**
  - `mount(): Promise<void>`
  - `unmount(): void`

**Dependencies:** `offline-db`, `outbox-queue`, `components/notify`, `utils/date-utils`

### ProfileController (`profile-controller.js`)

**Export:** `class ProfileController`

- **Constructor:** `constructor(api: ApiService, router: object)`
- **Methods:**
  - `mount(): Promise<void>`

**Dependencies:** `auth-store`, `components/notify`, `table/settings`

### SettingsController (`settings-controller.js`)

**Export:** `class SettingsController`

- **Constructor:** `constructor(api: ApiService, router: object)`
- **Methods:**
  - `mount(): Promise<void>`

**Dependencies:** `offline-db`, `components/notify`, `history-logger`, `user-store`

### ThemeController (`theme-controller.js`)

**Export:** `class ThemeController`

- **Constructor:** `constructor(toggleBtnId: string)`
- **Methods:**
  - `init(): void`

---

## 4. Utilities & Helpers

### Outbox Queue Facade (`outbox-queue.js`)

**Export:** `const outboxQueue`  
**Description:** Единая точка входа для постановки команд в offline-outbox.

- **Enqueue Methods:**
  - `enqueueCreate(payload: object): Promise<object>`
  - `enqueueEdit(ticketId: number|string, patch: object, opts?: {offline_uuid?: string}): Promise<object>`
  - `enqueueClose(ticketId: number|string, solution: string, opts?: {offline_uuid?: string}): Promise<object>`
  - `enqueueComment(ticketId: number|string, text: string, opts?: {offline_uuid?: string}): Promise<object>`
- **Read Methods:**
  - `getPendingBatch(limit?: number): Promise<Array>`
  - `getPendingByTicket(ticketId: number|string): Promise<Array>`
  - `getPendingByAuthor(authorId: number): Promise<Array>`
  - `getTicketFlags(ticketId: number|string): Promise<{hasCreate, hasEdit, hasClose, hasComment, count}>`
- **Management Methods:**
  - `remove(commandUuids: string[]): Promise<void>`
  - `markFailed(commandUuid: string, reason: string): Promise<object>`
  - `markRetry(commandUuid: string, reason: string, nextRetryAt: number): Promise<object>`
  - `resetToPending(commandUuid: string): Promise<object>`
  - `clear(): Promise<void>`
  - `getCounts(): Promise<{pending: number, failed: number}>`

**Dependencies:** `offline-db`, `auth-store`, `utils/uuid`

### NotificationsPoller (`notifications-poller.js`)

**Export:** `class NotificationsPoller`

- **Constructor:** `constructor(api: ApiService)`
- **Methods:**
  - `start(): void`
  - `stop(): void`

**Dependencies:** `components/notify`, `history-logger`, `staff-store`, `dict-store`, `config`, `utils/escape-html`

### History Logger (`history-logger.js`)

**Export:** `function logHistoryAction(text: string): void`

**Dependencies:** `config`

---

## 5. Key Architectural Relationships

1.  **Offline-First Pattern:** Все контроллеры записи (`CreateController`, `DetailsController`) используют `outboxQueue` вместо прямых вызовов API при отсутствии сети. `SyncManager` фоново синхронизирует очередь через `ApiService`.
2.  **State Isolation:** `authStore` хранит токен только в памяти (XSS-safe), тогда как `userStore` и `dictStore` работают с данными из localStorage/сервера для UI-рендеринга.
3.  **RBAC on Client:** `userStore.can()` является единственным источником правды для видимости UI-элементов редактирования в `DetailsController` и `TicketsController`.
4.  **Event-Driven Sync:** Компоненты общаются через Custom Events (`triggerSync`, `refreshSyncState`, `addresses:updated`, `auth:loggedin`), что снижает связанность контроллеров.
5.  **Mount/Unmount Lifecycle:** Все контроллеры реализуют паттерн `mount()/unmount()` с защитой от stale-closures (`_mountId` guard) для корректной очистки подписок и таймеров при SPA-навигации.
