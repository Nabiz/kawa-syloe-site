export const COFFEES = [
  {
    name: "Cappuccino",
    detail: "Espresso, mleko i puszysta pianka",
    mark: "☁",
  },
  { name: "Latte", detail: "Dużo mleka, łagodny smak", mark: "◒" },
  { name: "Americano", detail: "Czarna kawa, więcej do wypicia", mark: "◉" },
  { name: "Espresso", detail: "Mała, mocna, klasyczna", mark: "●" },
] as const;

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
}
export interface Order {
  id: string;
  coffeeType: string;
  userId: string;
  meetingId: string;
}
export interface State {
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
