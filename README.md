# vuex2pinia

A CLI codemod that migrates a Vue project from Vuex (3 or 4) to Pinia: the store itself and every place that uses it — components, templates, composables, router guards, API clients.

**English** | [Русский](#русский)

## Quick start

```bash
npx vuex2pinia ./src
```

By default this writes changes straight to your files — run with `--dry-run` first to preview the diff before anything is modified.

The root store file (the one calling `createStore` / `new Vuex.Store`) is found automatically; pass `--store <path>` if you have several.

## What it converts

**Store**
- Every module → its own `defineStore()`: namespaced and non-namespaced, nested, declared inline in `modules: {}` or as `const cart = {...}`
- Root-level `state` / `getters` / `mutations` / `actions` → `useRootStore`
- `createStore(...)` / `new Vuex.Store(...)` → `createPinia()`. In Vue 2 projects `Vue.use(Vuex)` → `Vue.use(PiniaVuePlugin)` and `new Vue({ store })` → `new Vue({ pinia: store })`
- `mutations` are merged into `actions`, `state.x` → `this.x`
- `commit` / `dispatch` in every form: local, `{ root: true }`, into nested modules, object style (`commit({ type })`), through a context object (`ctx.commit`), with constants (`commit(types.ADD)`, including constants imported from another file and TS `enum`s)
- `getters`, `rootState`, `rootGetters`, destructured context / state / getters parameters → the matching store (`this`, `useUserStore()`)
- Arrow functions and `function` expressions → methods where `this` is needed
- Modules split across files (`getters.js`, `mutations.js`, `import * as actions from './actions'`), modules made of named exports (`export const state`, ...) and Nuxt 2 `store/` directories
- TypeScript: `Module`, `GetterTree`, `ActionTree`, `MutationTree`, `Store` annotations are removed, the state type is kept as the return type of `state()`
- Name clashes, which Pinia does not allow (state, getters and actions share one namespace): an identity getter (`user: state => state.user`) is dropped, an action that only commits its twin mutation is merged into it, everything else is renamed (`save` mutation → `saveMutation`, `loading` → `setLoading`) and every caller is updated
- `dispatch('x').then(...)` on a non-`async` action is wrapped in `Promise.resolve(...)` — Vuex always returned a promise, Pinia does not

**Components and other code**
- `mapState` / `mapGetters` → Pinia `mapState(useXStore, ...)`, `mapMutations` / `mapActions` → `mapActions(useXStore, ...)` — array, object and function forms, with or without a namespace, `createNamespacedHelpers`, `Vuex.mapState`
- Root-level helpers are routed to the store that owns each name: `mapGetters({ empty: 'cart/isEmpty' })` → `mapState(useCartStore, { empty: 'isEmpty' })`
- `this.$store.state.cart.total` → `useCartStore().total`, `this.$store.getters['cart/isEmpty']` → `useCartStore().isEmpty`, `this.$store.commit(...)` / `.dispatch(...)` → a call on the store
- `const store = useStore()` (Composition API) → `const cartStore = useCartStore()` for exactly the stores that are used
- `import store from '@/store'` in router guards, API clients, etc. → `useUserStore()` inside the function
- `vuex-class` decorators (`@State`, `@Getter`, `@Action`, `@Mutation`, `namespace()`) → getters and methods on the class

**Template**
- `$store.state...`, `$store.getters[...]`, `$store.commit(...)`, `$store.dispatch(...)` in interpolations, bindings, `v-if`, `v-for`, event handlers → `cartStore.total`, with the store exposed from `<script setup>` or `computed`
- Template-only components get a `<script setup>` block

A store used once in a function is called inline (`useCartStore().total`); used several times, it is declared once at the top of that function (`const cartStore = useCartStore()`). Untouched code keeps its formatting (quotes, indentation, tabs, CRLF, comments) — only rewritten nodes are reprinted.

### Example

```js
// before
export default {
  namespaced: true,
  state: () => ({ items: [] }),
  getters: {
    count: (state) => state.items.length,
    label: (state, getters, rootState, rootGetters) => getters.count + ' / ' + rootGetters['user/name'],
  },
  mutations: {
    ADD(state, item) { state.items.push(item); },
  },
  actions: {
    async add({ commit, dispatch }, item) {
      commit('ADD', item);
      await dispatch('user/track', item, { root: true });
    },
  },
};
```

```js
// after
import { defineStore } from 'pinia';
import { useUserStore } from './user';

export const useCartStore = defineStore('cart', {
  state: () => ({ items: [] }),

  getters: {
    count: (state) => state.items.length,

    label(state) {
      return this.count + ' / ' + useUserStore().name;
    },
  },

  actions: {
    ADD(item) { this.items.push(item); },

    async add(item) {
      this.ADD(item);
      await useUserStore().track(item);
    },
  },
});
```

## Flags

| Flag | Description |
|---|---|
| `--store <path>` | Root store file (e.g. `src/store/index.ts`) or a Nuxt-style `store/` directory. Detected automatically when omitted |
| `--dry-run` | Print a diff instead of writing to disk |
| `--only <names>` | Run only specific transforms, comma-separated: `store`, `map-helpers`, `store-access`, `vuex-class`, `template` |
| `--ext <extensions>` | File extensions to scan, default `.vue,.ts,.js,.tsx,.jsx,.mjs` |
| `--root-store <id>` | Id of the store generated from root-level state, default `root` (→ `useRootStore`) |
| `--format` | Format changed files with the Prettier installed in your project |

## Known limitations

This is an early-stage tool — always run with `--dry-run` first, review the diff, and commit your working tree before applying changes.

Anything the tool cannot resolve with certainty is left in place with a `// TODO(vuex2pinia): ...` comment and listed at the end of the run, instead of being guessed:

- `commit(type)` / `dispatch(type)` with a type that is not known statically
- `store.subscribe`, `subscribeAction`, `watch`, `registerModule`, `replaceState`, `hotUpdate` — the comment names the Pinia counterpart (`$subscribe`, `$onAction`, ...)
- Vuex plugins (`plugins: [...]`), `vuex-persistedstate`, `vuex-router-sync` and similar libraries
- Modules created by a factory or registered dynamically (`require.context`, `import.meta.glob`), the same module object registered under two names
- `this.$axios` & co. inside actions — in Vuex `this` was the store instance
- Templates written in Pug; `'$store.state.x'` watched by its string path
- In a Nuxt `store/` directory, modules split into `state.js` / `actions.js` files inside a sub-folder
- Rewritten nodes are reprinted, so their formatting can differ slightly from the rest of the file — use `--format`

Files that still import `vuex` after the run are listed separately. Next steps: `npm install pinia`, resolve the `TODO(vuex2pinia)` comments, then `npm uninstall vuex`. The root store file now exports the Pinia instance, so `app.use(store)` keeps working.

## Programmatic use

```ts
import { migrate } from 'vuex2pinia';

const result = migrate({
  storePath: 'src/store/index.ts',
  files: ['src/App.vue', 'src/router.ts'],
});

for (const file of result.files) {
  if (file.changed) console.log(file.path, file.transformedSource);
}
```

`migrate` writes nothing itself; `result` also carries the generated stores, the report messages and the files still importing `vuex`.

## Related tools

- [vuegrate](https://github.com/BIGBASEDFLOPPA/vuegrate) — migrates Vue 2 components to Vue 3: Options API → Composition API (`<script setup>`) plus template syntax changes. The two tools complement each other: `vuex2pinia` moves the state management to Pinia, `vuegrate` moves the components to Vue 3.

## Feedback

Found a bug or have a pattern that isn't covered? [Open an issue](https://github.com/BIGBASEDFLOPPA/vuex2pinia/issues) — bug reports and feature requests are both welcome.

## Status

Early MVP, under active development. Issues and PRs welcome.

## License

MIT

---

## Русский

CLI-инструмент для автоматической миграции с Vuex (3 и 4) на Pinia: переносит сам стор и все места, где он используется — компоненты, шаблоны, composables, guard-ы роутера, API-клиенты.

### Быстрый старт

```bash
npx vuex2pinia ./src
```

По умолчанию изменения сразу пишутся в файлы — запустите с `--dry-run`, чтобы посмотреть diff, прежде чем что-то применять.

Корневой файл стора (тот, где вызывается `createStore` / `new Vuex.Store`) находится автоматически; если их несколько — укажите нужный через `--store <путь>`.

### Что конвертирует

**Стор:** каждый модуль → отдельный `defineStore()` (namespaced и нет, вложенные, инлайновые, разбитые по файлам, из именованных экспортов, Nuxt-папка `store/`), корневые `state`/`getters`/`mutations`/`actions` → `useRootStore`, `createStore` / `new Vuex.Store` → `createPinia()` (для Vue 2 — `PiniaVuePlugin` и `new Vue({ pinia })`), `mutations` сливаются в `actions`, `state.x` → `this.x`, `commit`/`dispatch` во всех формах (`{ root: true }`, объектный стиль, константы типов, `ctx.commit`), `getters`/`rootState`/`rootGetters` → обращения к нужному стору, Vuex-типы в TypeScript убираются. Конфликты имён (в Pinia state, getters и actions делят одно пространство имён) разрешаются переименованием с обновлением всех вызовов.

**Компоненты и остальной код:** `mapState`/`mapGetters` → `mapState(useXStore, ...)`, `mapMutations`/`mapActions` → `mapActions(useXStore, ...)` (массивы, объекты, функции, с неймспейсом и без, `createNamespacedHelpers`), `this.$store.state/getters/commit/dispatch` → обращения к Pinia-стору, `const store = useStore()` → `const cartStore = useCartStore()`, импортированный `store` в роутере и API-клиентах → `useXStore()` внутри функции, декораторы `vuex-class` → геттеры и методы класса.

**Template:** `$store.state...`, `$store.getters[...]`, `$store.commit(...)`, `$store.dispatch(...)` → `cartStore.total`, стор пробрасывается в шаблон через `<script setup>` или `computed`.

Нетронутый код сохраняет форматирование (кавычки, отступы, табы, CRLF, комментарии).

### Флаги

| Флаг | Описание |
|---|---|
| `--store <путь>` | Корневой файл стора (например `src/store/index.ts`) или Nuxt-папка `store/`. Если не указан — определяется автоматически |
| `--dry-run` | Показать diff без записи на диск |
| `--only <имена>` | Применить только указанные трансформации через запятую: `store`, `map-helpers`, `store-access`, `vuex-class`, `template` |
| `--ext <расширения>` | Какие расширения сканировать, по умолчанию `.vue,.ts,.js,.tsx,.jsx,.mjs` |
| `--root-store <id>` | Id стора, создаваемого из корневого state, по умолчанию `root` (→ `useRootStore`) |
| `--format` | Отформатировать изменённые файлы Prettier-ом, установленным в вашем проекте |

### Ограничения

Инструмент на раннем этапе — рекомендуется запускать с флагом `--dry-run`, проверять diff и коммитить рабочее состояние перед применением изменений.

Всё, что нельзя разрешить однозначно, остаётся на месте с комментарием `// TODO(vuex2pinia): ...` и попадает в отчёт в конце запуска: динамические типы в `commit(type)` / `dispatch(type)`, `store.subscribe` / `watch` / `registerModule` и подобные API, Vuex-плагины и библиотеки вроде `vuex-persistedstate`, модули-фабрики и динамическая регистрация, `this.$axios` внутри actions, Pug-шаблоны. Файлы, которые после миграции всё ещё импортируют `vuex`, перечисляются отдельно.

После запуска: `npm install pinia`, разобрать комментарии `TODO(vuex2pinia)`, затем `npm uninstall vuex`. Корневой файл стора теперь экспортирует экземпляр Pinia, поэтому `app.use(store)` продолжает работать.

### Связанные инструменты

- [vuegrate](https://github.com/BIGBASEDFLOPPA/vuegrate) — миграция компонентов с Vue 2 на Vue 3: Options API → Composition API (`<script setup>`) и изменения синтаксиса шаблонов. Инструменты дополняют друг друга: `vuex2pinia` переносит управление состоянием на Pinia, `vuegrate` — компоненты на Vue 3.

### Обратная связь

Нашли баг или паттерн, который не покрывается? [Создайте issue](https://github.com/BIGBASEDFLOPPA/vuex2pinia/issues) — багрепорты и фичи одинаково приветствуются.

### Лицензия

MIT
