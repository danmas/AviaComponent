import { add, quantity } from '../contract/units.ts';

const hours = quantity('norm-hour', 1);
const machine = quantity('machine-hour', 1);

export const mixed = add(hours, machine);
