import { describe, expect, it } from 'vitest';
import { code, runMigration } from './helpers.js';

const store = {
    'src/store/index.ts': code`
        import { createStore } from 'vuex';
        import cart from './cart';

        export default createStore({
          state: { count: 0 },
          getters: { double: (state) => state.count * 2 },
          mutations: { increment(state) { state.count++; } },
          modules: { cart },
        });
    `,
    'src/store/cart.ts': code`
        export default {
          namespaced: true,
          state: () => ({ total: 0 }),
          getters: { isEmpty: (state: { total: number }) => state.total === 0 },
          mutations: { SET_TOTAL(state: { total: number }, value: number) { state.total = value; } },
          actions: { async add({ commit }: any, price: number) { commit('SET_TOTAL', price); } },
        };
    `,
};

describe('vuex-class', () => {
    it('turns binding decorators into getters and methods', () => {
        const m = runMigration({
            ...store,
            'src/components/Counter.vue': code`
                <script lang="ts">
                import { Component, Vue, Prop } from 'vue-property-decorator';
                import { State, Getter, Action, Mutation, namespace } from 'vuex-class';

                const cart = namespace('cart');

                @Component
                export default class Counter extends Vue {
                  @Prop() readonly label!: string;

                  @State count!: number;
                  @State('count') renamed!: number;
                  @State((state) => state.cart.total) cartTotal!: number;
                  @Getter double!: number;
                  @Getter('cart/isEmpty') empty!: boolean;
                  @Mutation increment!: () => void;
                  @Action('cart/add') addToCart!: (price: number) => Promise<void>;

                  @cart.State total!: number;
                  @cart.Getter('isEmpty') cartIsEmpty!: boolean;
                  @cart.Mutation('SET_TOTAL') setTotal!: (value: number) => void;
                  @cart.Action add;
                }
                </script>
            `,
        });

        const output = m.output('src/components/Counter.vue');
        expect(output).not.toContain('vuex-class');
        expect(output).not.toContain('namespace(');
        expect(output).toContain('@Prop() readonly label!: string;');
        expect(output).toContain('get count(): number {\n    return useRootStore().count;\n  }');
        expect(output).toContain('get renamed(): number {\n    return useRootStore().count;\n  }');
        expect(output).toContain('get cartTotal(): number {\n    return useCartStore().total;\n  }');
        expect(output).toContain('get double(): number {\n    return useRootStore().double;\n  }');
        expect(output).toContain('get empty(): boolean {\n    return useCartStore().isEmpty;\n  }');
        expect(output).toContain('increment(): void {\n    return useRootStore().increment();\n  }');
        expect(output).toContain('addToCart(price: number): Promise<void> {\n    return useCartStore().add(price);\n  }');
        expect(output).toContain('get total(): number {\n    return useCartStore().total;\n  }');
        expect(output).toContain('get cartIsEmpty(): boolean {\n    return useCartStore().isEmpty;\n  }');
        expect(output).toContain('setTotal(value: number): void {\n    return useCartStore().SET_TOTAL(value);\n  }');
        expect(output).toContain('add(...args: any[]) {\n    return useCartStore().add(...args);\n  }');
        expect(output).toContain(`import { useRootStore } from '../store';`);
        expect(m.messages('todo')).toEqual([]);
    });

    it('keeps and flags bindings it cannot resolve', () => {
        const m = runMigration({
            ...store,
            'src/components/Broken.vue': code`
                <script lang="ts">
                import { Component, Vue } from 'vue-property-decorator';
                import { Getter } from 'vuex-class';

                @Component
                export default class Broken extends Vue {
                  @Getter('nope/missing') missing!: boolean;
                }
                </script>
            `,
        });

        const output = m.output('src/components/Broken.vue');
        expect(output).toMatch(/@Getter\('nope\/missing'\)\s+missing!: boolean;/);
        expect(output).toContain('// TODO(vuex2pinia): @Getter: "nope/missing" could not be matched to a Pinia store');
        expect(m.messages('todo')).toHaveLength(2);
    });
});
