import {TransformRegistry} from "../../core/transform-runner";
import {StoreTransformRegistry} from "../../core/store-transform-runner";

export const componentTransformRegistry: TransformRegistry = {
    scriptTransforms: {},
    templateTransforms: {},
};


export const storeTransformRegistry: StoreTransformRegistry = {
    storeTransforms: {},
};