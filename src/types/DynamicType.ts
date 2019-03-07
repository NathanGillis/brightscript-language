import { BrsType } from './BrsType';

export class DynamicType implements BrsType {
    public isAssignableTo(targetType: BrsType) {
        //everything can be dynamic
        return true;
    }

    /**
     * The dynamic type is convertible to everything.
     * @param targetType
     */
    public isConvertibleTo(targetType: BrsType) {
        return true;
    }

    public toString() {
        return 'dynamic';
    }

    public clone() {
        //no need to waste memory on a copy, these are all identical
        return this;
    }
}
