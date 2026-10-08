export function capitalize(segment: string): string {
    return segment.charAt(0).toUpperCase() + segment.slice(1);
}

/** `cart-items` / `cart_items` / `cart items` -> `CartItems`. */
function toPascalCase(segment: string): string {
    return segment
        .split(/[^A-Za-z0-9$]+/)
        .filter(Boolean)
        .map(capitalize)
        .join('');
}

export function toStoreExportName(pathSegments: string[]): string {
    let name = pathSegments.map(toPascalCase).join('');
    // `userStore` module -> `useUserStore`, not `useUserStoreStore`
    if (name.length > 'Store'.length && name.endsWith('Store')) name = name.slice(0, -'Store'.length);
    return `use${name}Store`;
}

/** `useCartStore` -> `cartStore`. */
export function toStoreInstanceName(exportName: string): string {
    const base = exportName.replace(/^use/, '');
    return base.charAt(0).toLowerCase() + base.slice(1);
}

export function uniqueName(desired: string, taken: (name: string) => boolean): string {
    if (!taken(desired)) return desired;
    for (let i = 2; ; i++) {
        const candidate = `${desired}${i}`;
        if (!taken(candidate)) return candidate;
    }
}
