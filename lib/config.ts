export const config = {
  company: {
    name: process.env.COMPANY_NAME ?? "Your Company",
    phone: process.env.COMPANY_PHONE ?? "",
    email: process.env.COMPANY_EMAIL ?? "",
    address: process.env.COMPANY_ADDRESS ?? "",
  },
  locations: (process.env.LOCATIONS ?? "KL,Penang,JB,Ipoh,Melaka,Kuantan,KK,Kuching")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean),
  pdf: {
    skipLineContaining: process.env.COMPANY_PHONE
      ? [process.env.COMPANY_PHONE]
      : [],
  },
};

export const companyConfig = config.company;
export const locationConfig = config.locations;
export const pdfConfig = config.pdf;
