import type { z } from 'zod';
export type TableInput = {
    name: string;
    columns: readonly string[];
};
export type TableQueryInterpolator<T extends TableInput> = {
    _name: T['name'];
    columns: {
        [K in T['columns'][number]]: K;
    };
    valueOf: () => T['name'];
    toString: () => T['name'];
} & {
    [K in T['columns'][number]]: `${T['name']}.${K}`;
};
export declare function getTable<T extends TableInput>(table: T): TableQueryInterpolator<T>;
export declare function getTableFromZodSchema<Name extends string, Schema extends z.ZodObject<any>>(name: Name, schema: Schema): TableQueryInterpolator<{
    name: Name;
    columns: Array<Extract<keyof z.infer<Schema>, string>>;
}>;
export type BaseTableQueryInterpolator = TableQueryInterpolator<{
    name: string;
    columns: [];
}>;
export type TableSqliteTypeMap<T extends BaseTableQueryInterpolator> = {
    [K in keyof T['columns']]: string;
};
export declare function getCreateTableQueryFromTable<T extends BaseTableQueryInterpolator>(table: T, columnTypeMap: TableSqliteTypeMap<T>): string;
