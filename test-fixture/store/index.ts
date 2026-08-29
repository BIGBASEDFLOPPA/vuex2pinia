import { createStore } from 'vuex';
import cartModule from './modules/cart';
import userModule from './modules/user';

export default createStore({
    modules: {
        cart: cartModule,
        userProfile: userModule,
        inlineThing: {
            namespaced: true,
            state: () => ({ foo: 1 }),
        },
    },
});