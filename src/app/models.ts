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
  isGuest?: boolean;
}
export interface Meeting {
  id: string;
  name: string;
  startsAt: string;
  coffeeTypes: string[];
  status?: "upcoming" | "ongoing" | "finished";
}
export interface Order {
  id: string;
  coffeeType: string;
  userId: string;
  meetingId: string;
  guestName?: string;
}
export interface State {
  coffeeTypes: CoffeeType[];
  user: User;
  meetings: Meeting[];
  orders: Order[];
  users: User[];
  guest?: { meetingId: string; expiresAt: string | null };
}
export interface GuestMenu {
  meeting: Meeting | null;
  coffeeTypes: CoffeeType[];
}
export interface Session {
  token: string;
  user: User;
}
export interface Config {
  supabaseUrl: string;
  supabasePublicKey: string;
}
