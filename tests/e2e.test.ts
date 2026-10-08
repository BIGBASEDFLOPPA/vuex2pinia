import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/index.js';
import { code } from './helpers.js';

/**
 * The strongest check we have: run the same scenario against the original
 * Vuex store and against the migrated Pinia stores and compare what happens.
 */

const TMP = join(dirname(fileURLToPath(import.meta.url)), '.tmp', 'e2e');

const fixture: Record<string, string> = {
    'api.js': code`
        export const calls = [];
        export default {
          async fetchUser() { return { id: 7, name: 'Ada', vip: true }; },
          async fetchCart(userId) { return [{ id: 1, price: 10 }, { id: 2, price: 5 }]; },
          save(items) { calls.push(['save', items.length]); return 'saved'; },
        };
    `,
    'store/types.js': code`
        export const SET_LOADING = 'SET_LOADING';
        export const ADD_ITEM = 'ADD_ITEM';
    `,
    'store/index.js': code`
        import { createStore } from 'vuex';
        import cart from './modules/cart';
        import user from './modules/user';
        import * as types from './types';

        export default createStore({
          state: {
            appName: 'Shop',
            loading: false,
            log: [],
          },
          getters: {
            appName: (state) => state.appName,
            title: (state, getters) => state.appName + ' / ' + getters.displayName,
          },
          mutations: {
            [types.SET_LOADING](state, value) {
              state.loading = value;
            },
            log: (state, entry) => state.log.push(entry),
          },
          actions: {
            async init({ commit, dispatch }) {
              commit(types.SET_LOADING, true);
              await dispatch('fetchUser');
              await dispatch('cart/load');
              commit(types.SET_LOADING, false);
            },
            log({ commit }, entry) {
              commit('log', 'action:' + entry);
            },
          },
          modules: { cart, user },
        });
    `,
    'store/modules/cart.js': code`
        import api from '../../api';
        import { ADD_ITEM } from '../types';

        const state = () => ({
          items: [],
          checkoutStatus: null,
        });

        const getters = {
          count: (state) => state.items.length,
          total: (state, getters, rootState, rootGetters) => {
            return state.items.reduce((sum, i) => sum + i.price, 0) * (rootGetters.isVip ? 0.5 : 1);
          },
          summary(state, getters) {
            return getters.count + ' items, ' + getters.total;
          },
          byId: (state) => (id) => state.items.find((i) => i.id === id),
          owner: (state, getters, rootState) => rootState.user.name,
          discountLabel: (state, { total }, { appName }) => appName + ':' + total,
        };

        const actions = {
          async load({ commit, state, rootState }) {
            if (state.items.length) return;
            const items = await api.fetchCart(rootState.user.id);
            items.forEach((item) => commit(ADD_ITEM, item));
          },
          add({ commit, getters, dispatch }, item) {
            if (getters.byId(item.id)) return Promise.resolve(false);
            commit(ADD_ITEM, item);
            commit('setCheckoutStatus', null);
            dispatch('log', 'add:' + item.id, { root: true });
            return dispatch('save').then((result) => result === 'saved');
          },
          save: ({ state }) => api.save(state.items),
          checkout(context) {
            context.commit('setCheckoutStatus', 'pending');
            context.commit('SET_LOADING', true, { root: true });
            return context.dispatch({ type: 'finish', status: 'done' });
          },
          finish({ commit, rootGetters }, payload) {
            commit('setCheckoutStatus', payload.status + ' by ' + rootGetters.displayName);
            commit('reset');
          },
        };

        const mutations = {
          [ADD_ITEM](state, item) {
            state.items.push(item);
          },
          setCheckoutStatus: (state, status) => (state.checkoutStatus = status),
          reset({ items }) {
            items.splice(0, items.length);
          },
        };

        export default {
          namespaced: true,
          state,
          getters,
          actions,
          mutations,
        };
    `,
    // not namespaced on purpose
    'store/modules/user.js': code`
        import api from '../../api';

        export default {
          state: {
            id: null,
            name: 'guest',
            vip: false,
          },
          getters: {
            displayName: (state) => state.name.toUpperCase(),
            isVip: (state) => state.vip,
          },
          mutations: {
            setUser(state, user) {
              Object.assign(state, user);
            },
          },
          actions: {
            setUser({ commit }, user) {
              commit('setUser', user);
            },
            async fetchUser({ dispatch, state }) {
              await dispatch('setUser', await api.fetchUser());
              return state.id;
            },
          },
        };
    `,
};

function writeProject(name: string, files: Record<string, string>): string {
    const root = join(TMP, name);
    rmSync(root, { recursive: true, force: true });
    for (const [path, content] of Object.entries(files)) {
        const file = join(root, path);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, content);
    }
    return root;
}

const load = (root: string, path: string) => import(/* @vite-ignore */ pathToFileURL(join(root, path)).href);

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

interface Outcome {
    title: string;
    userId: unknown;
    loadingAfterInit: boolean;
    countAfterInit: number;
    total: number;
    summary: string;
    owner: string;
    discountLabel: string;
    addNew: unknown;
    addExisting: unknown;
    byId: unknown;
    log: string[];
    status: string | null;
    itemsAfterCheckout: number;
    loadingAfterCheckout: boolean;
    saves: unknown[];
}

describe('migrated stores behave like the original Vuex store', () => {
    it('produces the same results for the same scenario', async () => {
        // --- original, on Vuex
        const vuexRoot = writeProject('vuex', fixture);
        const store = (await load(vuexRoot, 'store/index.js')).default;
        const vuexApi = await load(vuexRoot, 'api.js');

        const before: Partial<Outcome> = {};
        before.userId = undefined;
        await store.dispatch('init');
        before.userId = store.state.user.id;
        before.title = store.getters.title;
        before.loadingAfterInit = store.state.loading;
        before.countAfterInit = store.getters['cart/count'];
        before.total = store.getters['cart/total'];
        before.summary = store.getters['cart/summary'];
        before.owner = store.getters['cart/owner'];
        before.discountLabel = store.getters['cart/discountLabel'];
        before.addNew = await store.dispatch('cart/add', { id: 3, price: 1 });
        before.addExisting = await store.dispatch('cart/add', { id: 3, price: 1 });
        before.byId = store.getters['cart/byId'](3);
        store.dispatch('log', 'manual');
        store.commit('log', 'direct');
        before.log = [...store.state.log];
        await store.dispatch('cart/checkout');
        before.status = store.state.cart.checkoutStatus;
        before.itemsAfterCheckout = store.state.cart.items.length;
        before.loadingAfterCheckout = store.state.loading;
        before.saves = [...vuexApi.calls];

        // --- migrated, on Pinia
        const sourceRoot = writeProject('pinia', fixture);
        const result = migrate({
            storePath: join(sourceRoot, 'store/index.js'),
            files: Object.keys(fixture).map((path) => join(sourceRoot, path)),
        });
        for (const file of result.files) writeFileSync(file.path, file.transformedSource);

        expect(result.remainingVuexFiles).toEqual([]);
        expect(result.messages.filter((m) => m.level === 'todo')).toEqual([]);

        const { setActivePinia } = await import('pinia');
        const root = await load(sourceRoot, 'store/index.js');
        const { useCartStore } = await load(sourceRoot, 'store/modules/cart.js');
        const { useUserStore } = await load(sourceRoot, 'store/modules/user.js');
        const piniaApi = await load(sourceRoot, 'api.js');

        setActivePinia(root.default);
        const rootStore = root.useRootStore();
        const cartStore = useCartStore();
        const userStore = useUserStore();

        const after: Partial<Outcome> = {};
        after.userId = undefined;
        await rootStore.init();
        after.userId = userStore.id;
        after.title = rootStore.title;
        after.loadingAfterInit = rootStore.loading;
        after.countAfterInit = cartStore.count;
        after.total = cartStore.total;
        after.summary = cartStore.summary;
        after.owner = cartStore.owner;
        after.discountLabel = cartStore.discountLabel;
        after.addNew = await cartStore.add({ id: 3, price: 1 });
        after.addExisting = await cartStore.add({ id: 3, price: 1 });
        after.byId = cartStore.byId(3);
        // state, mutation and action were all called "log": Pinia needs three distinct names
        rootStore.logAction('manual');
        rootStore.logMutation('direct');
        after.log = [...rootStore.$state.log];
        await cartStore.checkout();
        after.status = cartStore.checkoutStatus;
        after.itemsAfterCheckout = cartStore.items.length;
        after.loadingAfterCheckout = rootStore.loading;
        after.saves = [...piniaApi.calls];

        expect(after).toEqual(before);
        // sanity: the scenario really exercised the stores
        expect(before).toMatchObject({
            userId: 7,
            title: 'Shop / ADA',
            countAfterInit: 2,
            total: 7.5,
            summary: '2 items, 7.5',
            owner: 'Ada',
            discountLabel: 'Shop:7.5',
            addNew: true,
            addExisting: false,
            log: ['action:add:3', 'action:manual', 'direct'],
            status: 'done by ADA',
            itemsAfterCheckout: 0,
            loadingAfterCheckout: true,
            saves: [['save', 3]],
        });
    });
});
