import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { PaginationQuerySchema } from '../../pagination/paginate';

export const ListNodesQuerySchema = PaginationQuerySchema.extend({
  level: z.string().min(1).max(32).optional(),
}).strict();

export class ListNodesQueryDto extends createZodDto(ListNodesQuerySchema) {}
