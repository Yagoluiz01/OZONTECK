import { supabaseAdmin } from "../../../config/supabase.js";

export class BaseRepository {
  constructor(table) {
    this.table = table;
  }

  async findAll() {
    const { data, error } = await supabaseAdmin
      .from(this.table)
      .select("*");

    if (error) throw error;
    return data || [];
  }

  async findById(id) {
    const { data, error } = await supabaseAdmin
      .from(this.table)
      .select("*")
      .eq("id", id)
      .single();

    if (error) return null;
    return data;
  }

  async count() {
    const { count, error } = await supabaseAdmin
      .from(this.table)
      .select("*", { head: true, count: "exact" });

    if (error) throw error;
    return count || 0;
  }
}