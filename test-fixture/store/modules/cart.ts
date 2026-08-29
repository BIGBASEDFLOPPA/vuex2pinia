// @ts-ignore
import itemsModule from './cart-items';

export default {
    namespaced: true,
    modules: {
        items: itemsModule,
    },
    state: () => ({
        total: 0,
    }),
    getters: {
        isEmpty: (state: { total: number }) => state.total === 0,
    },
    mutations: {
        SET_TOTAL(state: { total: number }, value: number) {
            state.total = value;
        },
    },
};