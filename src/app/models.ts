export interface CoffeeType {
  name: string;
  detail: string;
  attendanceOnly: boolean;
  active: boolean;
}

// Used only by the local demo. The live catalogue comes from Supabase.
export const DEFAULT_COFFEE_TYPES: CoffeeType[] = [
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
    detail: "Będę na spotkaniu, bez zamawiania napoju",
    attendanceOnly: true,
    active: true,
  },
];

export interface User {
  id: string;
  firstName: string;
  lastName: string;
  isAdmin: boolean;
}
export interface Meeting {
  id: string;
  name: string;
  startsAt: string;
  coffeeTypes: string[];
}
export interface Order {
  id: string;
  coffeeType: string;
  userId: string;
  meetingId: string;
}
export interface State {
  coffeeTypes: CoffeeType[];
  user: User;
  meetings: Meeting[];
  orders: Order[];
  users: User[];
}
export interface Session {
  token: string;
  user: User;
}
export interface Config {
  supabaseUrl: string;
  supabasePublicKey: string;
}
