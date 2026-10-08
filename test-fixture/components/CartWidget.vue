<template>
  <div>{{ total }} — {{ isEmpty }}</div>
</template>

<script>
import { mapState, mapGetters, mapActions, mapMutations } from 'vuex';

export default {
  computed: {
    ...mapState('cart', ['total']),
    ...mapGetters('cart', ['isEmpty']),
    ...mapState('userProfile', { name: 'name' }),
  },
  methods: {
    ...mapActions('cart', ['incrementTotal']),
    ...mapMutations('cart', ['SET_TOTAL']),
    ...mapState(['globalFlag']),
  },
};
</script>