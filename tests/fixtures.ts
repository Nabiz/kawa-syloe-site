import type { CoffeeType } from "../src/app/models";

export const COFFEE_TYPES: CoffeeType[] = [
  {
    name: "Czarna",
    detail: "Kawa bez mleka",
    attendanceOnly: false,
    active: true,
  },
  {
    name: "Biała",
    detail: "Kawa z mlekiem",
    attendanceOnly: false,
    active: true,
  },
  {
    name: "Herbata Zimowa",
    detail: "Rozgrzewająca herbata",
    attendanceOnly: false,
    active: true,
  },
  {
    name: "Inna (daj znać po spotkaniu)",
    detail: "Daj znać po spotkaniu",
    attendanceOnly: true,
    active: true,
  },
];
