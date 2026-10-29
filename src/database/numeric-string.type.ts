import { Type, type EntityProperty, type Platform } from '@mikro-orm/core';

export class NumericStringType extends Type<string | null, string | null> {
  override convertToJSValue(value: string | number | null): string | null {
    if (value == null) return null;
    if (typeof value === 'number') {
      throw new Error('numeric column was decoded as number');
    }
    return value;
  }

  override convertToDatabaseValue(value: string | null): string | null {
    return value;
  }

  override getColumnType(_prop: EntityProperty, _platform: Platform): string {
    return 'numeric(20,2)';
  }
}
