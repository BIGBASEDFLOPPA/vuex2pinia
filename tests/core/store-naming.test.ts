import { describe, expect, it } from 'vitest';
import { capitalize, toStoreExportName, toStoreInstanceName, uniqueName } from '../../src/core/store-naming.js';

describe('capitalize', () => {
    it('upper-cases the first character only', () => {
        expect(capitalize('cart')).toBe('Cart');
        expect(capitalize('cartItems')).toBe('CartItems');
        expect(capitalize('')).toBe('');
    });
});

describe('toStoreExportName', () => {
    it('builds useXStore from a module name', () => {
        expect(toStoreExportName(['cart'])).toBe('useCartStore');
    });

    it('joins the segments of a nested module path', () => {
        expect(toStoreExportName(['shop', 'cart'])).toBe('useShopCartStore');
    });

    it('turns kebab-case, snake_case and spaced names into PascalCase', () => {
        expect(toStoreExportName(['cart-items'])).toBe('useCartItemsStore');
        expect(toStoreExportName(['cart_items'])).toBe('useCartItemsStore');
        expect(toStoreExportName(['cart items'])).toBe('useCartItemsStore');
    });

    it('does not repeat the Store suffix', () => {
        expect(toStoreExportName(['userStore'])).toBe('useUserStore');
    });

    it('keeps a module that is called just "store"', () => {
        expect(toStoreExportName(['store'])).toBe('useStoreStore');
    });
});

describe('toStoreInstanceName', () => {
    it('derives the variable name from the export name', () => {
        expect(toStoreInstanceName('useCartStore')).toBe('cartStore');
        expect(toStoreInstanceName('useShopCartStore')).toBe('shopCartStore');
    });
});

describe('uniqueName', () => {
    it('returns the desired name when it is free', () => {
        expect(uniqueName('cartStore', () => false)).toBe('cartStore');
    });

    it('appends the first free numeric suffix, starting at 2', () => {
        const taken = new Set(['cartStore', 'cartStore2']);
        expect(uniqueName('cartStore', (name) => taken.has(name))).toBe('cartStore3');
    });
});
