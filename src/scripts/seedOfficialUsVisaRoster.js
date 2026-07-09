import db from "../config/db.js";
import { importOfficialUsVisaRoster } from "../services/usVisaKpiEmployeeService.js";

const OFFICIAL_US_VISA_ROSTER = [
  { "SIB-ID": "SIB-6677", "Agent Name": "Amerah Basman" },
  { "SIB-ID": "SIB-6691", "Agent Name": "Ariel Alejo" },
  { "SIB-ID": "SIB-6695", "Agent Name": "Bejay Lauresta" },
  { "SIB-ID": "SIB-6414", "Agent Name": "Camela Padilla" },
  { "SIB-ID": "SIB-6583", "Agent Name": "Caryl Khen Recomes" },
  { "SIB-ID": "SIB-6239", "Agent Name": "Chricel Mae Gementiza" },
  { "SIB-ID": "SIB-5003", "Agent Name": "Deanne Gay Malacaste" },
  { "SIB-ID": "SIB-6726", "Agent Name": "Dee Jay Llanto" },
  { "SIB-ID": "SIB-6147", "Agent Name": "Dianne Casalda" },
  { "SIB-ID": "SIB-5617", "Agent Name": "Edmundo Laurente" },
  { "SIB-ID": "SIB-3856", "Agent Name": "Elma Purca" },
  { "SIB-ID": "SIB-6676", "Agent Name": "Emie Joy Malibong" },
  { "SIB-ID": "SIB-6678", "Agent Name": "Genelyn Idorot" },
  { "SIB-ID": "SIB-6440", "Agent Name": "Gerald Lagnason" },
  { "SIB-ID": "SIB-6644", "Agent Name": "Geramie Morano" },
  { "SIB-ID": "SIB-6749", "Agent Name": "Glenda Dacanay" },
  { "SIB-ID": "SIB-6521", "Agent Name": "Ian Louie Decena" },
  { "SIB-ID": "SIB-3231", "Agent Name": "Jacel Digaynon" },
  { "SIB-ID": "SIB-3823", "Agent Name": "Jerissa Canton" },
  { "SIB-ID": "SIB-6643", "Agent Name": "Jesell Repaja" },
  { "SIB-ID": "SIB-6731", "Agent Name": "John Jake Barton" },
  { "SIB-ID": "SIB-6725", "Agent Name": "John Venric C. Caasi" },
  { "SIB-ID": "SIB-6520", "Agent Name": "Jordan Hugo" },
  { "SIB-ID": "SIB-4791", "Agent Name": "Josie Jane Blazo" },
  { "SIB-ID": "SIB-5706", "Agent Name": "Joyce Sumatra" },
  { "SIB-ID": "SIB-6642", "Agent Name": "Kevin Empinado" },
  { "SIB-ID": "SIB-5781", "Agent Name": "Krizzia Palen" },
  { "SIB-ID": "SIB-4764", "Agent Name": "Marieta Sumabal" },
  { "SIB-ID": "SIB-6748", "Agent Name": "Marlon Mahinay" },
  { "SIB-ID": "SIB-4699", "Agent Name": "Marvin Abellar" },
  { "SIB-ID": "SIB-6701", "Agent Name": "Renalyn Ebon" },
  { "SIB-ID": "SIB-5014", "Agent Name": "Rhobillen Bardos" },
  { "SIB-ID": "SIB-6737", "Agent Name": "Rich Mhar Muñoz" },
  { "SIB-ID": "SIB-6622", "Agent Name": "Rod Adrian Aquiliño" },
  { "SIB-ID": "SIB-4768", "Agent Name": "Ruzel Jean Mendoza" },
  { "SIB-ID": "SIB-5509", "Agent Name": "Shaina Mae Maay" },
  { "SIB-ID": "SIB-5237", "Agent Name": "Stepanie Ray Sarabia" },
  { "SIB-ID": "SIB-6746", "Agent Name": "Urie Granada" },
];

async function run() {
  console.log("OFFICIAL US VISA ROSTER SEED STARTED");

  const result = await importOfficialUsVisaRoster({
    rows: OFFICIAL_US_VISA_ROSTER,
    deactivateMissing: true,
  });

  console.log("OFFICIAL US VISA ROSTER SEED COMPLETED");
  console.log(result.summary);
}

run()
  .catch((error) => {
    console.error("OFFICIAL US VISA ROSTER SEED FAILED", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.end();
  });
