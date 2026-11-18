// PREVIEW ONLY: first import of the guest bundle (src/mem_census.ts).
import { censusFlags, censusOfName, installMemCensus } from "./mem_census.ts";
installMemCensus("guest", censusFlags(censusOfName(self.name)));
