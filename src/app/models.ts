export interface CoffeeType {
  name: string;
  detail: string;
  attendanceOnly: boolean;
  active: boolean;
}

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
