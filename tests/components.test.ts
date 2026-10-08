import { describe, expect, it } from 'vitest';
import { code, runMigration } from './helpers.js';

const store = {
    'src/store/index.js': code`
        import { createStore } from 'vuex';
        import cart from './modules/cart';
        import user from './modules/user';

        export default createStore({
          state: { appName: 'Shop', loading: false },
          getters: { isReady: (state) => !state.loading },
          mutations: { setLoading(state, value) { state.loading = value; } },
          actions: { async boot({ commit }) { commit('setLoading', false); } },
          modules: { cart, user },
        });
    `,
    'src/store/modules/cart.js': code`
        export default {
          namespaced: true,
          state: () => ({ total: 0, coupon: null, lines: [] }),
          getters: {
            isEmpty: (state) => state.total === 0,
            byId: (state) => (id) => state.lines.find((l) => l.id === id),
          },
          mutations: {
            SET_TOTAL(state, value) { state.total = value; },
          },
          actions: {
            async addItem({ commit, state }, item) { commit('SET_TOTAL', state.total + item.price); },
            clear({ commit }) { commit('SET_TOTAL', 0); },
          },
        };
    `,
    // not namespaced: getters / mutations / actions live in the global namespace
    'src/store/modules/user.js': code`
        export default {
          state: () => ({ name: 'guest', token: null }),
          getters: { isLoggedIn: (state) => !!state.token },
          mutations: { SET_TOKEN(state, token) { state.token = token; } },
          actions: {
            login({ commit }, token) { commit('SET_TOKEN', token); },
          },
        };
    `,
};

function migrateComponent(source: string, path = 'src/components/Comp.vue') {
    const m = runMigration({ ...store, [path]: source });
    return { m, output: m.output(path) };
}

describe('map helpers', () => {
    it('converts namespaced helpers and merges the imports', () => {
        const { output, m } = migrateComponent(code`
            <script>
            import { mapState, mapGetters, mapActions, mapMutations } from 'vuex';

            export default {
              computed: {
                ...mapState('cart', ['total', 'coupon']),
                ...mapGetters('cart', ['isEmpty']),
                ...mapGetters('cart', { cartIsEmpty: 'isEmpty' }),
              },
              methods: {
                ...mapActions('cart', ['addItem']),
                ...mapMutations('cart', { setTotal: 'SET_TOTAL' }),
              },
            };
            </script>
        `);

        expect(output).toBe(code`
            <script>
            import { mapState, mapActions } from 'pinia';
            import { useCartStore } from '../store/modules/cart';

            export default {
              computed: {
                ...mapState(useCartStore, ['total', 'coupon']),
                ...mapState(useCartStore, ['isEmpty']),
                ...mapState(useCartStore, { cartIsEmpty: 'isEmpty' }),
              },
              methods: {
                ...mapActions(useCartStore, ['addItem']),
                ...mapActions(useCartStore, { setTotal: 'SET_TOTAL' }),
              },
            };
            </script>
        `);
        expect(m.result.remainingVuexFiles).toEqual([]);
    });

    it('routes root-level helpers to the store that owns each name', () => {
        const { output } = migrateComponent(code`
            <script>
            import { mapState, mapGetters, mapActions, mapMutations } from 'vuex';

            export default {
              computed: {
                ...mapState(['appName', 'loading']),
                ...mapGetters(['isReady', 'isLoggedIn']),
                ...mapGetters({ empty: 'cart/isEmpty', ready: 'isReady' }),
              },
              methods: {
                ...mapActions({ signIn: 'login', clearCart: 'cart/clear', boot: 'boot' }),
                ...mapMutations(['setLoading', 'SET_TOKEN']),
              },
            };
            </script>
        `);

        expect(output).toContain(`...mapState(useRootStore, ['appName', 'loading']),`);
        expect(output).toContain(`...mapState(useRootStore, ['isReady']),`);
        expect(output).toContain(`...mapState(useUserStore, ['isLoggedIn']),`);
        expect(output).toContain(`...mapState(useCartStore, { empty: 'isEmpty' }),`);
        expect(output).toContain(`...mapState(useRootStore, { ready: 'isReady' }),`);
        expect(output).toContain(`...mapActions(useUserStore, { signIn: 'login' }),`);
        expect(output).toContain(`...mapActions(useCartStore, { clearCart: 'clear' }),`);
        expect(output).toContain(`...mapActions(useRootStore, ['boot']),`);
        expect(output).toContain(`...mapActions(useRootStore, ['setLoading']),`);
        expect(output).toContain(`...mapActions(useUserStore, ['SET_TOKEN']),`);
    });

    it('handles function mappings in mapState', () => {
        const { output } = migrateComponent(code`
            <script>
            import { mapState } from 'vuex';

            export default {
              data: () => ({ bonus: 1 }),
              computed: {
                ...mapState('cart', {
                  coupon: (state) => state.coupon,
                  withBonus(state) {
                    return state.total + this.bonus;
                  },
                }),
                ...mapState({
                  userName: (state) => state.user.name,
                  title: (state, getters) => state.appName + (getters.isLoggedIn ? '!' : '?'),
                  mixed(state) {
                    return state.cart.total + state.user.name + this.bonus;
                  },
                  wholeCart: 'cart',
                }),
              },
            };
            </script>
        `);

        // only touches the store's own state: stays a mapState function
        expect(output).toContain('...mapState(useCartStore, {\n      coupon: (state) => state.coupon,\n      withBonus(state) {\n        return state.total + this.bonus;');
        // everything else becomes a plain computed property
        expect(output).toContain('userName() {\n      return useUserStore().name;\n    },');
        expect(output).toContain(`title() {\n      return useRootStore().appName + (useUserStore().isLoggedIn ? '!' : '?');\n    },`);
        expect(output).toContain('return useCartStore().total + useUserStore().name + this.bonus;');
        expect(output).toContain('wholeCart() {\n      return useCartStore().$state;\n    },');
        expect(output).not.toContain('vuex');
    });

    it('supports helpers used as a whole value, createNamespacedHelpers and Vuex.mapX', () => {
        const { output } = migrateComponent(
            code`
                import Vuex, { createNamespacedHelpers } from 'vuex';

                const { mapState, mapActions: mapCartActions } = createNamespacedHelpers('cart');
                const cartHelpers = createNamespacedHelpers('cart/');

                export const cartMixin = {
                  computed: mapState(['total']),
                  methods: { ...mapCartActions(['clear']), ...cartHelpers.mapMutations(['SET_TOTAL']) },
                };

                export const rootMixin = {
                  computed: Vuex.mapGetters(['isReady', 'isLoggedIn']),
                };
            `,
            'src/mixins.js',
        );

        expect(output).toBe(code`
            import { mapState, mapActions } from 'pinia';
            import { useRootStore } from './store';
            import { useUserStore } from './store/modules/user';
            import { useCartStore } from './store/modules/cart';

            export const cartMixin = {
              computed: mapState(useCartStore, ['total']),
              methods: { ...mapActions(useCartStore, ['clear']), ...mapActions(useCartStore, ['SET_TOTAL']) },
            };

            export const rootMixin = {
              computed: {
                ...mapState(useRootStore, ['isReady']),
                ...mapState(useUserStore, ['isLoggedIn']),
              },
            };
        `);
    });

    it('leaves what it cannot map as an aliased Vuex call with a TODO', () => {
        const { output, m } = migrateComponent(code`
            <script>
            import { mapState, mapGetters } from 'vuex';
            const names = ['total'];

            export default {
              computed: {
                ...mapState('cart', ['total']),
                ...mapState('cart', names),
                ...mapState('nope', ['x']),
                ...mapGetters(['isReady', 'doesNotExist']),
              },
            };
            </script>
        `);

        expect(output).toContain(`import { mapState as vuexMapState, mapGetters } from 'vuex';`);
        expect(output).toContain(`import { mapState } from 'pinia';`);
        expect(output).toContain(`...mapState(useCartStore, ['total']),`);
        expect(output).toContain(`...vuexMapState('cart', names),`);
        expect(output).toContain(`...vuexMapState('nope', ['x']),`);
        expect(output).toContain(`...mapState(useRootStore, ['isReady']),`);
        expect(output).toContain(`...mapGetters(['doesNotExist']),`);
        expect(m.messages('todo')).toHaveLength(3);
        expect(m.result.remainingVuexFiles).toHaveLength(1);
    });
});

describe('this.$store', () => {
    it('rewrites state, getters, commit and dispatch in Options API components', () => {
        const { output } = migrateComponent(code`
            <script>
            export default {
              computed: {
                total() {
                  return this.$store.state.cart.total;
                },
                summary() {
                  return this.$store.state.cart.total + (this.$store.getters['cart/isEmpty'] ? ' (empty)' : '');
                },
                line() {
                  return this.$store.getters['cart/byId'](1) ?? this.$store.state.user?.name;
                },
              },
              watch: {
                '$store.state.loading'() {},
              },
              methods: {
                async submit() {
                  this.$store.commit('setLoading', true);
                  await this.$store.dispatch('cart/addItem', { price: 1 });
                  this.$store.dispatch('login', 'token').then(() => {
                    this.$store.commit('setLoading', false);
                  });
                  this.$store.commit({ type: 'cart/SET_TOTAL', value: 2 });
                },
              },
            };
            </script>
        `);

        expect(output).toContain('total() {\n      return useCartStore().total;\n    },');
        expect(output).toContain(`const cartStore = useCartStore();\n      return cartStore.total + (cartStore.isEmpty ? ' (empty)' : '');`);
        expect(output).toContain('return useCartStore().byId(1) ?? useUserStore()?.name;');
        expect(output).toContain('const rootStore = useRootStore();\n      const cartStore = useCartStore();\n      rootStore.setLoading(true);');
        expect(output).toContain('await cartStore.addItem({ price: 1 });');
        expect(output).toContain(`Promise.resolve(useUserStore().login('token')).then(() => {\n        rootStore.setLoading(false);`);
        expect(output).toContain(`cartStore.SET_TOTAL({ type: 'cart/SET_TOTAL', value: 2 });`);
        expect(output).toContain('// TODO(vuex2pinia): "$store.state.loading" is watched by its string path');
        expect(output).toContain(`import { useCartStore } from '../store/modules/cart';`);
    });

    it('flags store APIs that have no Pinia counterpart', () => {
        const { output, m } = migrateComponent(code`
            <script>
            export default {
              created() {
                this.unsubscribe = this.$store.subscribe(() => {});
                this.$store.registerModule('late', {});
                this.$store.commit(this.type);
                helper(this.$store);
              },
            };
            </script>
        `);

        expect(output).toContain('this.unsubscribe = this.$store.subscribe(() => {});');
        expect(m.messages('todo')).toEqual([
            expect.stringContaining('$subscribe'),
            expect.stringContaining('registerModule'),
            expect.stringContaining('dynamic type'),
            expect.stringContaining('used directly'),
        ]);
    });
});

describe('composition API', () => {
    it('replaces useStore() with the Pinia stores that are actually used', () => {
        const { output } = migrateComponent(code`
            <script setup>
            import { computed } from 'vue';
            import { useStore } from 'vuex';

            const store = useStore();

            const total = computed(() => store.state.cart.total);
            const empty = computed(() => store.getters['cart/isEmpty']);
            const loggedIn = computed(() => store.getters.isLoggedIn);

            function add(item) {
              store.commit('setLoading', true);
              return store.dispatch('cart/addItem', item);
            }
            </script>

            <template>
              <button :disabled="store.state.loading" @click="add({ price: 1 })">{{ total }} {{ $store.state.appName }}</button>
            </template>
        `);

        expect(output).not.toContain('vuex');
        expect(output).not.toContain('useStore');
        expect(output).toContain('const cartStore = useCartStore();');
        expect(output).toContain('const userStore = useUserStore();');
        expect(output).toContain('const rootStore = useRootStore();');
        expect(output).toContain('const total = computed(() => cartStore.total);');
        expect(output).toContain('const empty = computed(() => cartStore.isEmpty);');
        expect(output).toContain('const loggedIn = computed(() => userStore.isLoggedIn);');
        expect(output).toContain('rootStore.setLoading(true);\n  return cartStore.addItem(item);');
        // the template used the removed `store` variable and `$store`
        expect(output).toContain('<button :disabled="rootStore.loading" @click="add({ price: 1 })">{{ total }} {{ rootStore.appName }}</button>');
    });

    it('handles setup() functions, destructuring and stores that cannot be dropped', () => {
        const { output, m } = migrateComponent(
            code`
                import { computed } from 'vue';
                import { useStore } from 'vuex';

                export function useCart() {
                  const { state, getters, commit, dispatch } = useStore();
                  const total = computed(() => state.cart.total);
                  const empty = computed(() => getters['cart/isEmpty']);
                  return { total, empty, reset: () => commit('cart/SET_TOTAL', 0), clear: () => dispatch('cart/clear') };
                }

                export function useAuth() {
                  const store = useStore();
                  store.subscribeAction(() => {});
                  return { login: (token) => store.dispatch('login', token), name: useStore().state.user.name };
                }
            `,
            'src/composables.js',
        );

        expect(output).toContain('export function useCart() {\n  const cartStore = useCartStore();\n  const total = computed(() => cartStore.total);');
        expect(output).toContain('reset: () => cartStore.SET_TOTAL(0), clear: () => cartStore.clear()');
        // still needed for subscribeAction(), so the declaration and the import stay
        expect(output).toContain('const userStore = useUserStore();\n  const store = useStore();');
        expect(output).toContain('login: (token) => userStore.login(token), name: useUserStore().name');
        expect(m.messages('todo')).toEqual([expect.stringContaining('$onAction')]);
        expect(m.result.remainingVuexFiles).toHaveLength(1);
    });
});

describe('templates', () => {
    it('rewrites $store in every kind of template expression of an Options API component', () => {
        const { output } = migrateComponent(code`
            <template>
              <div :class="{ empty: $store.getters['cart/isEmpty'] }" v-if="!$store.state.loading">
                <li v-for="(line, i) in $store.state.cart.lines" :key="i">{{ line.id }}</li>
                <button @click="$store.commit('cart/SET_TOTAL', 0)">reset</button>
                <button @click="$store.dispatch('login', 'x'); done = true">login</button>
                <input :value="$store.state.user.name" @input="(e) => $store.commit('SET_TOKEN', e.target.value)" />
                {{ $store.state.appName }} - {{ notTheStore.$store }}
              </div>
            </template>

            <script>
            export default {
              name: 'Comp',
              data() {
                return { done: false, notTheStore: {} };
              },
              methods: {
                noop() {},
              },
            };
            </script>
        `);

        expect(output).toContain(`<div :class="{ empty: cartStore.isEmpty }" v-if="!rootStore.loading">`);
        expect(output).toContain('<li v-for="(line, i) in cartStore.lines" :key="i">');
        expect(output).toContain('<button @click="cartStore.SET_TOTAL(0)">reset</button>');
        expect(output).toContain(`<button @click="userStore.login('x'); done = true">login</button>`);
        expect(output).toContain(`<input :value="userStore.name" @input="(e) => userStore.SET_TOKEN(e.target.value)" />`);
        expect(output).toContain('{{ rootStore.appName }} - {{ notTheStore.$store }}');
        // the stores are exposed through computed properties, placed before `methods`
        expect(output).toMatch(/computed: \{\n {4}cartStore\(\) \{\n {6}return useCartStore\(\);\n {4}\},[\s\S]*userStore\(\) \{[\s\S]*\},\n\n? {2}methods: \{/);
    });

    it('adds a <script setup> block to template-only components', () => {
        const { output } = migrateComponent(code`
            <template>
              <p @click="$store.commit('setLoading', true)">{{ $store.state.cart.total }}</p>
            </template>
        `);

        expect(output).toBe(code`
            <script setup>
            import { useRootStore } from '../store';
            import { useCartStore } from '../store/modules/cart';

            const rootStore = useRootStore();
            const cartStore = useCartStore();
            </script>

            <template>
              <p @click="rootStore.setLoading(true)">{{ cartStore.total }}</p>
            </template>
        `);
    });

    it('does not touch templates it cannot parse', () => {
        const { output, m } = migrateComponent(code`
            <template lang="pug">
            p {{ $store.state.cart.total }}
            </template>

            <script>
            export default {};
            </script>
        `);

        expect(output).toContain('p {{ $store.state.cart.total }}');
        expect(m.messages('todo')).toEqual([expect.stringContaining('written in "pug"')]);
    });
});

describe('store used outside of components', () => {
    it('rewrites the imported store instance (router guards, API clients)', () => {
        const m = runMigration({
            ...store,
            'tsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
            'src/main.js': code`
                import { createApp } from 'vue';
                import App from './App.vue';
                import store from './store';

                createApp(App).use(store).mount('#app');
            `,
            'src/router/index.js': code`
                import { createRouter } from 'vue-router';
                import store from '@/store';
                import routes from '@/router/routes';

                const router = createRouter({ routes });

                router.beforeEach((to) => {
                  if (to.meta.auth && !store.getters.isLoggedIn) return '/login';
                  store.commit('setLoading', true);
                  store.commit('cart/SET_TOTAL', store.state.cart.total);
                });

                router.afterEach(() => store.commit('setLoading', false));

                store.dispatch('boot');

                export default router;
            `,
        });

        // the default export of the store file is the Pinia instance now, so app.use(store) keeps working
        expect(m.changed('src/main.js')).toBe(false);

        const router = m.output('src/router/index.js');
        expect(router).toContain(`import store, { useRootStore } from '@/store';`);
        expect(router).toContain(`import { useUserStore } from '@/store/modules/user';`);
        expect(router).toContain(`if (to.meta.auth && !useUserStore().isLoggedIn) return '/login';`);
        expect(router).toContain('const cartStore = useCartStore();');
        expect(router).toContain('cartStore.SET_TOTAL(cartStore.total);');
        expect(router).toContain('router.afterEach(() => useRootStore().setLoading(false));');
        // outside of any function Pinia may not be active yet: the instance is passed explicitly
        expect(router).toContain('useRootStore(store).boot();');
    });

    it('migrates code in the root store file that uses the fresh instance', () => {
        const m = runMigration({
            'src/store/index.js': code`
                import { createStore } from 'vuex';

                export const store = createStore({
                  state: { ready: false },
                  mutations: { setReady(state) { state.ready = true; } },
                });

                store.commit('setReady');

                if (import.meta.hot) {
                  store.hotUpdate({});
                }
            `,
            'src/other.js': code`
                import { store } from './store';
                export const isReady = () => store.state.ready;
            `,
        });

        const root = m.output('src/store/index.js');
        expect(root).toContain('export const store = createPinia();');
        expect(root).toContain('useRootStore(store).setReady();');
        expect(root).toContain('// TODO(vuex2pinia): store.hotUpdate() does not exist in Pinia');
        expect(m.output('src/other.js')).toBe(code`
            import { useRootStore } from './store';
            export const isReady = () => useRootStore().ready;
        `);
    });

    it('can be limited to specific transforms', () => {
        const m = runMigration(
            {
                ...store,
                'src/components/Comp.vue': code`
                    <script>
                    import { mapState } from 'vuex';
                    export default {
                      computed: mapState('cart', ['total']),
                      methods: { go() { this.$store.commit('setLoading', true); } },
                    };
                    </script>
                `,
            },
            { only: ['store', 'map-helpers'] },
        );

        const output = m.output('src/components/Comp.vue');
        expect(output).toContain(`computed: mapState(useCartStore, ['total']),`);
        expect(output).toContain(`this.$store.commit('setLoading', true);`);
    });
});
