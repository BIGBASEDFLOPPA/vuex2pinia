export default {
    state: () => ({
        name: 'guest',
    }),
    getters: {
        displayName: (state: { name: string }) => state.name,
    },
};