import { describe, expect, it } from 'vitest';
import { code, runMigration } from './helpers.js';

describe('store modules', () => {
    it('converts a namespaced module into a defineStore() call', () => {
        const m = runMigration({
            'src/store/index.js': code`
                import { createStore } from 'vuex';
                import cart from './modules/cart';

                export default createStore({
                  modules: { cart },
                });
            `,
            'src/store/modules/cart.js': code`
                export default {
                  namespaced: true,
                  state: () => ({
                    total: 0,
                  }),
                  getters: {
                    isEmpty: (state) => state.total === 0,
                  },
                  mutations: {
                    SET_TOTAL(state, value) {
                      state.total = value;
                    },
                  },
                  actions: {
                    async reset({ commit }) {
                      commit('SET_TOTAL', 0);
                    },
                  },
                };
            `,
        });

        expect(m.output('src/store/modules/cart.js')).toBe(code`
            import { defineStore } from 'pinia';

            export const useCartStore = defineStore('cart', {
              state: () => ({
                total: 0,
              }),

              getters: {
                isEmpty: (state) => state.total === 0,
              },

              actions: {
                SET_TOTAL(value) {
                  this.total = value;
                },

                async reset() {
                  this.SET_TOTAL(0);
                },
              },
            });
        `);

        expect(m.output('src/store/index.js')).toBe(code`
            import { createPinia } from 'pinia';

            export default createPinia();
        `);
        expect(m.result.stores).toEqual([expect.objectContaining({ storeId: 'cart', exportName: 'useCartStore' })]);
        expect(m.result.remainingVuexFiles).toEqual([]);
    });

    it('creates a root store from root-level state and replaces the Vuex instance with Pinia', () => {
        const m = runMigration({
            'src/store/index.js': code`
                import { createStore } from 'vuex';

                const store = createStore({
                  strict: true,
                  state: { count: 0 },
                  mutations: {
                    increment(state) { state.count++; },
                  },
                  actions: {
                    incrementLater({ commit }) { setTimeout(() => commit('increment')); },
                  },
                });

                export default store;
            `,
        });

        const output = m.output('src/store/index.js');
        expect(output).toContain(`export const useRootStore = defineStore('root', {`);
        expect(output).toContain('state: () => ({');
        expect(output).toContain('increment() { this.count++; }');
        expect(output).toContain('incrementLater() { setTimeout(() => this.increment()); }');
        expect(output).toContain('const store = createPinia();');
        expect(output).not.toContain('vuex');
        expect(output).not.toContain('strict');
    });

    it('handles Vue 2: new Vuex.Store, Vue.use(Vuex) and new Vue({ store })', () => {
        const m = runMigration({
            'package.json': JSON.stringify({ dependencies: { vue: '^2.7.14', vuex: '^3.6.2' } }),
            'src/store/index.js': code`
                import Vue from 'vue';
                import Vuex from 'vuex';
                import user from './user';

                Vue.use(Vuex);

                export default new Vuex.Store({
                  modules: { user },
                });
            `,
            'src/store/user.js': code`
                export default {
                  namespaced: true,
                  state: { name: '' },
                };
            `,
            'src/main.js': code`
                import Vue from 'vue';
                import store from './store';
                import App from './App.vue';

                new Vue({ store, render: (h) => h(App) }).$mount('#app');
            `,
        });

        expect(m.result.vueVersion).toBe(2);
        const root = m.output('src/store/index.js');
        expect(root).toContain(`import { createPinia, PiniaVuePlugin } from 'pinia';`);
        expect(root).toContain('Vue.use(PiniaVuePlugin);');
        expect(root).toContain('export default createPinia();');
        expect(root).not.toContain('Vuex');
        expect(m.output('src/main.js')).toContain('new Vue({ pinia: store, render: (h) => h(App) })');
        // a plain object state becomes a factory
        expect(m.output('src/store/user.js')).toContain(`state: () => ({\n    name: '',\n  }),`);
    });

    it('folds separately declared state / getters / mutations / actions into the store', () => {
        const m = runMigration({
            'src/store/index.js': code`
                import { createStore } from 'vuex';
                import counter from './counter';
                export default createStore({ modules: { counter } });
            `,
            'src/store/counter.js': code`
                // initial state
                const state = () => ({ count: 0 });

                const getters = {
                  double: (state) => state.count * 2,
                };

                const mutations = {
                  add(state, n) {
                    state.count += n;
                  },
                };

                const actions = {
                  addTwice({ commit }, n) {
                    commit('add', n);
                    commit('add', n);
                  },
                };

                export default { namespaced: true, state, getters, mutations, actions };
            `,
        });

        const output = m.output('src/store/counter.js');
        expect(output).not.toMatch(/const (state|getters|mutations|actions) =/);
        expect(output).toContain('// initial state\n  state: () => ({ count: 0 }),');
        expect(output).toContain('double: (state) => state.count * 2,');
        expect(output).toContain('add(n) {\n      this.count += n;\n    },');
        expect(output).toContain('addTwice(n) {\n      this.add(n);\n      this.add(n);\n    },');
    });

    it('rewrites getters that use other getters, root state and root getters', () => {
        const m = runMigration({
            'src/store/index.js': code`
                import { createStore } from 'vuex';
                import cart from './cart';
                import user from './user';
                export default createStore({ state: { currency: 'EUR' }, modules: { cart, user } });
            `,
            'src/store/cart.js': code`
                export default {
                  namespaced: true,
                  state: () => ({ items: [] }),
                  getters: {
                    count: (state) => state.items.length,
                    label: (state, getters) => getters.count + ' items',
                    price: (state, getters, rootState, rootGetters) => {
                      const factor = rootGetters['user/isVip'] ? 0.9 : 1;
                      return state.items.length * factor + rootState.currency + rootState.user.name;
                    },
                    both(state, { count, label }) {
                      return count + label;
                    },
                  },
                };
            `,
            'src/store/user.js': code`
                export default {
                  namespaced: true,
                  state: () => ({ name: '', vip: false }),
                  getters: { isVip: (state) => state.vip },
                };
            `,
        });

        const output = m.output('src/store/cart.js');
        expect(output).toContain('count: (state) => state.items.length,');
        // needs `this`, so it can no longer be an arrow function
        expect(output).toContain(`label(state) {\n      return this.count + ' items';\n    },`);
        expect(output).toContain('const userStore = useUserStore();');
        expect(output).toContain('const factor = userStore.isVip ? 0.9 : 1;');
        expect(output).toContain('return state.items.length * factor + useRootStore().currency + userStore.name;');
        expect(output).toContain('const { count, label } = this;');
        expect(output).toContain(`import { useUserStore } from './user';`);
        expect(output).toContain(`import { useRootStore } from './index';`);
    });

    it('rewrites every flavour of commit / dispatch inside actions', () => {
        const m = runMigration({
            'src/store/index.js': code`
                import { createStore } from 'vuex';
                import a from './a';
                import b from './b';
                export default createStore({
                  mutations: { ping(state) {} },
                  actions: { async boot() {} },
                  state: { ready: false },
                  modules: { a, b },
                });
            `,
            'src/store/a.js': code`
                export default {
                  namespaced: true,
                  state: () => ({ value: 1 }),
                  mutations: {
                    set(state, value) { state.value = value; },
                  },
                  actions: {
                    plain({ commit, dispatch, state, getters }, payload) {
                      commit('set', payload);
                      commit({ type: 'set', value: payload });
                      commit('b/push', state.value, { root: true });
                      commit('ping', null, { root: true });
                      dispatch('other', 1);
                      dispatch('boot', null, { root: true });
                      dispatch('b/load', { id: 1 }, { root: true }).then(() => {});
                      return dispatch('other').then(() => getters.nothing);
                    },
                    other(context) {
                      context.commit('set', context.state.value + context.rootState.b.list.length);
                      return context.rootGetters['b/size'];
                    },
                    async asyncOne() {},
                    usesAsync({ dispatch }) {
                      return dispatch('asyncOne').then(() => 1);
                    },
                  },
                };
            `,
            'src/store/b.js': code`
                export default {
                  namespaced: true,
                  state: () => ({ list: [] }),
                  getters: { size: (state) => state.list.length },
                  mutations: { push(state, item) { state.list.push(item); } },
                  actions: { load(ctx, { id }) { return id; } },
                };
            `,
        });

        const output = m.output('src/store/a.js');
        expect(output).toContain('this.set(payload);');
        // object-style commit: the whole object is the payload
        expect(output).toContain(`this.set({ type: 'set', value: payload });`);
        expect(output).toContain('bStore.push(this.value);');
        expect(output).toContain('rootStore.ping();');
        expect(output).toContain('this.other(1);');
        expect(output).toContain('rootStore.boot();');
        // dispatch() always returned a promise; a non-async action may not
        expect(output).toContain('Promise.resolve(bStore.load({ id: 1 })).then(() => {});');
        expect(output).toContain('return Promise.resolve(this.other()).then(');
        expect(output).toContain('return this.asyncOne().then(() => 1);');
        expect(output).toContain('this.set(this.value + bStore.list.length);');
        expect(output).toContain('return bStore.size;');
        expect(m.messages('todo')).toEqual([expect.stringContaining('getter "a/nothing" was not found')]);
    });

    it('converts arrow and function-expression members into methods', () => {
        const m = runMigration({
            'src/store/index.js': code`
                import { createStore } from 'vuex';
                export default createStore({
                  state: { n: 0, list: [] },
                  mutations: {
                    inc: (state) => state.n++,
                    set: (state, n) => {
                      state.n = n;
                    },
                    push: function (state, item) {
                      state.list.push(item);
                    },
                    patch({ list }, item) {
                      list.push(item);
                    },
                  },
                  actions: {
                    load: async ({ commit }, n) => commit('set', n),
                    run: function ({ commit }) {
                      commit('inc');
                    },
                  },
                });
            `,
        });

        const output = m.output('src/store/index.js');
        expect(output).toContain('inc() {\n      this.n++;\n    },');
        expect(output).toContain('set(n) {\n      this.n = n;\n    },');
        expect(output).toMatch(/push: function ?\(item\) \{\n {6}this\.list\.push\(item\);/);
        expect(output).toContain('patch(item) {\n      const { list } = this;\n      list.push(item);\n    },');
        expect(output).toContain('async load(n) {\n      return this.set(n);\n    },');
        expect(output).toMatch(/run: function ?\(\) \{\n {6}this\.inc\(\);/);
    });

    it('keeps mutation-type constants as computed keys', () => {
        const m = runMigration({
            'src/store/index.js': code`
                import { createStore } from 'vuex';
                import * as types from './types';
                import { DONE } from './types';

                export default createStore({
                  state: { loading: false },
                  mutations: {
                    [types.START](state) { state.loading = true; },
                    [DONE](state) { state.loading = false; },
                  },
                  actions: {
                    async run({ commit }) {
                      commit(types.START);
                      commit(DONE);
                    },
                  },
                });
            `,
            'src/store/types.js': code`
                export const START = 'START_LOADING';
                export const DONE = 'DONE_LOADING';
            `,
            'src/App.vue': code`
                <script>
                export default {
                  methods: {
                    go() {
                      this.$store.commit('START_LOADING');
                    },
                  },
                };
                </script>
            `,
        });

        const output = m.output('src/store/index.js');
        expect(output).toContain('[types.START]() { this.loading = true; },');
        expect(output).toContain('this[types.START]();');
        expect(output).toContain('this[DONE]();');
        // from the outside the resolved name is used
        expect(m.output('src/App.vue')).toContain('useRootStore().START_LOADING();');
    });

    it('resolves name clashes between state, getters, mutations and actions', () => {
        const m = runMigration({
            'src/store/index.js': code`
                import { createStore } from 'vuex';
                export default createStore({
                  state: { user: null, items: [], loading: false },
                  getters: {
                    user: (state) => state.user,
                    items: (state) => state.items.filter(Boolean),
                  },
                  mutations: {
                    setUser(state, user) { state.user = user; },
                    save(state) { state.loading = true; },
                    loading(state, value) { state.loading = value; },
                  },
                  actions: {
                    setUser({ commit }, user) { commit('setUser', user); },
                    async save({ commit, getters }) {
                      commit('save');
                      commit('loading', false);
                      return getters.user + getters.items.length;
                    },
                  },
                });
            `,
            'src/App.vue': code`
                <script>
                import { mapGetters, mapMutations, mapActions } from 'vuex';
                export default {
                  computed: mapGetters(['user', 'items']),
                  methods: {
                    ...mapMutations(['save', 'loading']),
                    ...mapActions(['setUser']),
                    run() {
                      this.$store.commit('save');
                      this.$store.dispatch('save');
                      this.$store.dispatch('setUser', 1).then(() => this.$store.getters.items);
                    },
                  },
                };
                </script>
            `,
        });

        const output = m.output('src/store/index.js');
        // identity getter is redundant in Pinia
        expect(output).not.toContain('user: (state) => state.user');
        expect(output).toContain('itemsGetter: (state) => state.items.filter(Boolean),');
        // forwarding action merged into its mutation
        expect(output.match(/setUser\(/g)).toHaveLength(1);
        expect(output).toContain('saveMutation() { this.loading = true; },');
        expect(output).toContain('setLoading(value) { this.loading = value; },');
        expect(output).toContain('this.saveMutation();');
        expect(output).toContain('this.setLoading(false);');
        expect(output).toContain('return this.user + this.itemsGetter.length;');

        const component = m.output('src/App.vue');
        expect(component).toContain(`computed: mapState(useRootStore, { user: 'user', items: 'itemsGetter' }),`);
        expect(component).toContain(`...mapActions(useRootStore, { save: 'saveMutation', loading: 'setLoading' }),`);
        expect(component).toContain(`...mapActions(useRootStore, ['setUser']),`);
        expect(component).toContain('rootStore.saveMutation();');
        expect(component).toContain('rootStore.save();');
        expect(component).toContain('Promise.resolve(rootStore.setUser(1)).then(() => rootStore.itemsGetter);');
        expect(m.messages('info').join('\n')).toContain('mutation "save" was renamed to "saveMutation"');
    });

    it('handles nested, inline and non-namespaced modules', () => {
        const m = runMigration({
            'src/store/index.js': code`
                import { createStore } from 'vuex';
                import shop from './shop';

                export default createStore({
                  modules: {
                    shop,
                    prefs: {
                      state: () => ({ theme: 'light' }),
                      getters: { isDark: (state) => state.theme === 'dark' },
                      mutations: { setTheme(state, theme) { state.theme = theme; } },
                    },
                  },
                });
            `,
            'src/store/shop.js': code`
                const cart = {
                  namespaced: true,
                  state: () => ({ lines: [] }),
                  mutations: { add(state, line) { state.lines.push(line); } },
                };

                export default {
                  namespaced: true,
                  modules: { cart },
                  state: () => ({ open: true }),
                  getters: {
                    lineCount: (state) => state.cart.lines.length,
                  },
                  actions: {
                    buy({ commit, state, rootGetters }, line) {
                      if (!state.open || rootGetters.isDark) return;
                      commit('cart/add', line);
                      commit('setTheme', 'dark', { root: true });
                    },
                  },
                };
            `,
            'src/App.vue': code`
                <script>
                import { mapState, mapGetters, mapMutations } from 'vuex';
                export default {
                  computed: {
                    ...mapState('shop/cart', ['lines']),
                    ...mapState({ theme: (state) => state.prefs.theme, open: (state) => state.shop.open }),
                    ...mapGetters(['isDark']),
                  },
                  methods: {
                    ...mapMutations(['setTheme']),
                    ...mapMutations('shop/cart', ['add']),
                    go() {
                      return this.$store.state.shop.cart.lines.length + this.$store.state.prefs.theme;
                    },
                  },
                };
                </script>
            `,
        });

        expect(m.result.stores.map((s) => `${s.storeId}:${s.exportName}`)).toEqual([
            'shop:useShopStore',
            'shop/cart:useShopCartStore',
            'prefs:usePrefsStore',
        ]);

        const shop = m.output('src/store/shop.js');
        expect(shop).toContain(`export const useShopCartStore = defineStore('shop/cart', {`);
        expect(shop).toContain(`export const useShopStore = defineStore('shop', {`);
        expect(shop).toContain('lineCount: (state) => useShopCartStore().lines.length,');
        expect(shop).toContain('const prefsStore = usePrefsStore();');
        expect(shop).toContain('if (!this.open || prefsStore.isDark) return;');
        expect(shop).toContain('useShopCartStore().add(line);');
        expect(shop).toContain(`prefsStore.setTheme('dark');`);
        expect(shop).not.toContain('modules:');

        // the inline module is hoisted next to the Pinia instance
        expect(m.output('src/store/index.js')).toContain(`export const usePrefsStore = defineStore('prefs', {`);

        const component = m.output('src/App.vue');
        expect(component).toContain(`...mapState(useShopCartStore, ['lines']),`);
        expect(component).toContain('theme() {\n      return usePrefsStore().theme;\n    },');
        expect(component).toContain('open() {\n      return useShopStore().open;\n    },');
        expect(component).toContain(`...mapState(usePrefsStore, ['isDark']),`);
        expect(component).toContain(`...mapActions(usePrefsStore, ['setTheme']),`);
        expect(component).toContain(`...mapActions(useShopCartStore, ['add']),`);
        expect(component).toContain('return useShopCartStore().lines.length + usePrefsStore().theme;');
    });

    it('supports modules split across files (getters.js, actions.js, ...)', () => {
        const m = runMigration({
            'src/store/index.js': code`
                import { createStore } from 'vuex';
                import user from './user';
                export default createStore({ modules: { user } });
            `,
            'src/store/user/index.js': code`
                import state from './state';
                import getters from './getters';
                import mutations from './mutations';
                import * as actions from './actions';

                export default { namespaced: true, state, getters, mutations, actions };
            `,
            'src/store/user/state.js': code`
                export default () => ({ name: '', token: null });
            `,
            'src/store/user/getters.js': code`
                export default {
                  loggedIn: (state) => !!state.token,
                  greeting: (state, getters) => (getters.loggedIn ? 'Hi ' + state.name : 'Hi'),
                };
            `,
            'src/store/user/mutations.js': code`
                export default {
                  setToken(state, token) {
                    state.token = token;
                  },
                };
            `,
            'src/store/user/actions.js': code`
                export const login = async ({ commit }, token) => {
                  commit('setToken', token);
                };

                export function logout({ commit, getters }) {
                  if (getters.loggedIn) commit('setToken', null);
                }
            `,
        });

        expect(m.output('src/store/user/index.js')).toBe(code`
            import state from './state';
            import getters from './getters';
            import mutations from './mutations';
            import * as actions from './actions';

            import { defineStore } from 'pinia';

            export const useUserStore = defineStore('user', {
              state,
              getters,

              actions: {
                ...mutations,
                ...actions,
              },
            });
        `);
        expect(m.changed('src/store/user/state.js')).toBe(false);
        expect(m.output('src/store/user/getters.js')).toContain(`greeting(state) {\n    return (this.loggedIn ? 'Hi ' + state.name : 'Hi');\n  },`);
        expect(m.output('src/store/user/mutations.js')).toContain('setToken(token) {\n    this.token = token;\n  },');
        const actions = m.output('src/store/user/actions.js');
        expect(actions).toMatch(/export const login = async function ?\(token\) \{\n {2}this\.setToken\(token\);\n\};/);
        expect(actions).toContain('export function logout() {\n  if (this.loggedIn) this.setToken(null);\n}');
    });

    it('supports modules made of named exports and Nuxt-style store directories', () => {
        const m = runMigration(
            {
                'store/index.js': code`
                    export const state = () => ({ ready: false });
                    export const mutations = { setReady(state) { state.ready = true; } };
                `,
                'store/todos.js': code`
                    export const state = () => ({ list: [] });
                    export const getters = { count: (state) => state.list.length };
                    export const mutations = { add(state, todo) { state.list.push(todo); } };
                    export const actions = {
                      async fetch({ commit, rootState }) {
                        if (rootState.ready) commit('add', 1);
                        commit('setReady', null, { root: true });
                      },
                    };
                `,
                'pages/index.vue': code`
                    <template>
                      <p>{{ $store.state.todos.list.length }}</p>
                    </template>

                    <script>
                    export default {
                      mounted() {
                        this.$store.dispatch('todos/fetch');
                      },
                    };
                    </script>
                `,
            },
            { storePath: 'store' },
        );

        expect(m.result.stores.map((s) => s.exportName)).toEqual(['useRootStore', 'useTodosStore']);
        const todos = m.output('store/todos.js');
        expect(todos).toContain(`export const useTodosStore = defineStore('todos', {`);
        expect(todos).toContain('if (rootStore.ready) this.add(1);');
        expect(todos).toContain('rootStore.setReady();');
        expect(m.output('store/index.js')).toContain(`export const useRootStore = defineStore('root', {`);
        const page = m.output('pages/index.vue');
        expect(page).toContain('{{ todosStore.list.length }}');
        expect(page).toContain('useTodosStore().fetch();');
    });

    it('drops Vuex typings and keeps the state type in TypeScript modules', () => {
        const m = runMigration({
            'src/store/index.ts': code`
                import { createStore, Store } from 'vuex';
                import counter, { CounterState } from './counter';

                export interface RootState { counter: CounterState }

                const store: Store<RootState> = createStore<RootState>({ modules: { counter } });
                export default store;
            `,
            'src/store/counter.ts': code`
                import type { Module, MutationTree, ActionTree } from 'vuex';
                import type { RootState } from './index';

                export interface CounterState { count: number }

                const state: CounterState = { count: 0 };

                const mutations: MutationTree<CounterState> = {
                  add(state, n: number) { state.count += n; },
                };

                export const actions: ActionTree<CounterState, RootState> = {
                  async addLater({ commit }, n: number): Promise<void> { commit('add', n); },
                };

                const counter: Module<CounterState, RootState> = { namespaced: true, state, mutations, actions };
                export default counter;
            `,
        });

        const output = m.output('src/store/counter.ts');
        expect(output).not.toContain('vuex');
        expect(output).not.toContain('RootState');
        expect(output).toContain('state: (): CounterState => ({\n    count: 0,\n  }),');
        expect(output).toContain('add(n: number) { this.count += n; },');
        // exported parts stay where they are, without the Vuex type
        expect(output).toContain('export const actions = {');
        expect(output).toContain('async addLater(n: number): Promise<void> { this.add(n); },');
        expect(output).toContain('...actions,');

        const root = m.output('src/store/index.ts');
        expect(root).toContain('const store = createPinia();');
        expect(root).not.toContain('vuex');
        expect(m.result.remainingVuexFiles).toEqual([]);
    });

    it('reports what it cannot migrate instead of guessing', () => {
        const m = runMigration({
            'src/store/index.js': code`
                import { createStore } from 'vuex';
                import createPersistedState from 'vuex-persistedstate';
                import makeModule from './factory';

                export default createStore({
                  plugins: [createPersistedState()],
                  state: { a: 1 },
                  actions: {
                    run({ commit, dispatch }, type) {
                      commit(type);
                      dispatch('missing/action');
                      this.$router.push('/');
                    },
                  },
                  modules: { dynamic: makeModule() },
                });
            `,
            'src/store/factory.js': 'export default () => ({ state: {} });\n',
        });

        const output = m.output('src/store/index.js');
        expect(output).toContain('// TODO(vuex2pinia): Vuex plugins were removed with the store');
        expect(output).toContain('// TODO(vuex2pinia): action "missing/action" was not found in the store');
        expect(output).toContain('this[type]();');
        expect(m.result.unresolvedModules).toEqual([expect.objectContaining({ path: 'dynamic' })]);
        const todos = m.messages('todo').join('\n');
        expect(todos).toContain('in Vuex `this` was the store instance here');
        expect(todos).toContain('vuex-persistedstate does not work with Pinia');
    });

    it('keeps formatting details of the original file (CRLF, tabs, double quotes)', () => {
        const source = [
            'import { createStore } from "vuex";',
            '',
            'export default createStore({',
            '\tstate: {',
            '\t\tname: "x",',
            '\t},',
            '\tmutations: {',
            '\t\trename(state, name) {',
            '\t\t\tstate.name = name;',
            '\t\t},',
            '\t},',
            '});',
            '',
        ].join('\r\n');

        const output = runMigration({ 'src/store/index.js': source }).output('src/store/index.js');

        expect(output).toContain('import { defineStore, createPinia } from "pinia";\r\n');
        expect(output).toContain('export const useRootStore = defineStore("root", {\r\n\tstate: () => ({\r\n\t\tname: "x",\r\n\t}),\r\n');
        expect(output).toContain('\t\trename(name) {\r\n\t\t\tthis.name = name;\r\n\t\t},\r\n');
        expect(output.replace(/\r\n/g, '')).not.toContain('\n');
        expect(output).not.toMatch(/^ +\S/m);
    });
});
